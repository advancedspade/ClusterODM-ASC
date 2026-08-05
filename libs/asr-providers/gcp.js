/**
 * ClusterODM autoscaling provider for Google Compute Engine.
 *
 * Provisions private-IP-only Container-Optimized OS workers via the Compute
 * REST API (no docker-machine / SSH). Workers upload via ADC; the gateway
 * streams post-teardown downloads via ADC as well.
 */
"use strict";

const {Storage} = require("@google-cloud/storage");
const AbstractASRProvider = require("../classes/AbstractASRProvider");
const GceMachine = require("../classes/GceMachine");
const {fetchGatewayInternalIp} = GceMachine;
const logger = require("../logger");

const COS_IMAGE = "projects/cos-cloud/global/images/family/cos-stable";
const DEFAULT_NODE_ONLINE_ATTEMPTS = 60;
const DEFAULT_NODE_ONLINE_SLEEP_MS = 5000;
// Curated outputs only — excludes opensfm/, images/, gcp/, and all.zip.
// Must stay in sync with NodeODM config-default.json gcsUploadPaths.
const DEFAULT_GCS_UPLOAD_PATHS = [
    "odm_orthophoto", "odm_dem", "odm_report", "odm_georeferencing",
    "odm_meshing", "odm_texturing", "odm_texturing_25d", "odm_filterpoints",
    "3d_tiles", "orthophoto_tiles", "rtk_analysis",
    "cameras.json", "images.json", "img_list.txt", "log.json",
    "options.json", "task_output.txt", "benchmark.txt"
].join(",");

function buildWorkerStartupScript(){
    // Per-task values are read from sibling metadata keys at boot.
    return `#!/bin/bash
set -euo pipefail
META=http://metadata.google.internal/computeMetadata/v1/instance/attributes
H='Metadata-Flavor: Google'
get_attr() { curl -fsS -H "$H" "$META/$1"; }

DOCKER_IMAGE=$(get_attr docker-image)
DOCKER_MEMORY=$(get_attr docker-memory || true)
NODE_TOKEN=$(get_attr node-token)
WEBHOOK=$(get_attr webhook)
GCS_BUCKET=$(get_attr gcs-bucket)
GCS_PROJECT_ID=$(get_attr gcs-project-id || true)
GCS_UPLOAD_PREFIX=$(get_attr gcs-upload-prefix || true)
GCS_UPLOAD_PATHS=$(get_attr gcs-upload-paths || true)
REGISTRY_HOST=$(get_attr registry-host)

# COS mounts / read-only, so the default HOME=/root makes both
# docker-credential-gcr and the docker CLI fail to write .docker/config.json.
export HOME=/var/lib/clusterodm-worker
mkdir -p "\${HOME}"

docker-credential-gcr configure-docker --registries="\${REGISTRY_HOST}"

ARGS=(run -d --name nodeodm -p 3000:3000 --restart unless-stopped)
# ASR deletes the VM as soon as the task settles, so anything NodeODM only
# writes to the container log is unrecoverable unless it ships to Cloud Logging.
# gcplogs reads the project from the metadata server.
ARGS+=(--label service=clusterodm-worker --log-driver=gcplogs --log-opt labels=service)
if [[ -n "\${DOCKER_MEMORY}" ]]; then
  ARGS+=(--memory="\${DOCKER_MEMORY}" --memory-swap="\${DOCKER_MEMORY}")
fi
ARGS+=("\${DOCKER_IMAGE}" -q 1)
ARGS+=(--gcs_bucket "\${GCS_BUCKET}")
if [[ -n "\${GCS_PROJECT_ID}" ]]; then
  ARGS+=(--gcs_project_id "\${GCS_PROJECT_ID}")
fi
ARGS+=(--gcs_upload_prefix "\${GCS_UPLOAD_PREFIX:-outputs}")
ARGS+=(--gcs_upload_paths "\${GCS_UPLOAD_PATHS:-${DEFAULT_GCS_UPLOAD_PATHS}}")
ARGS+=(--gcs_cleanup_after_upload)
# ClusterODM builds the download zip on demand from outputs/<name>/, so
# workers skip the local all.zip build/upload.
ARGS+=(--gcs_skip_local_archive)
ARGS+=(--webhook "\${WEBHOOK}")
ARGS+=(--token "\${NODE_TOKEN}")

docker "\${ARGS[@]}"
`;
}

module.exports = class GCPAsrProvider extends AbstractASRProvider{
    constructor(userConfig){
        super({
            project: "CHANGEME!",
            zone: ["us-central1-a"],
            network: "default",
            subnetwork: "",
            tags: ["clusterodm-worker"],
            serviceAccount: "CHANGEME!",
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            machineImage: COS_IMAGE,
            diskType: "pd-balanced",
            useInternalIpOnly: true,
            skipFirewallCreate: true,
            preemptible: false,
            maxRuntime: 172800,
            maxUploadTime: 7200,
            instanceLimit: 1,
            createRetries: 12,
            imageSizeMapping: [
                {maxImages: 800, slug: "c3-highmem-22", storage: 500, dockerMemory: "154g", fallbacks: [
                    {slug: "n2-highmem-16", dockerMemory: "112g"},
                    {slug: "n2d-highmem-16", dockerMemory: "112g"}
                ]},
                // c3-highmem-44 would be the faster primary here, but it needs
                // 44 vCPU against a default C3_CPUS regional quota of 24.
                {maxImages: 5000, slug: "n2-highmem-32", storage: 1000, dockerMemory: "224g", fallbacks: [
                    {slug: "n2d-highmem-32", dockerMemory: "224g"}
                ]}
            ],
            gcs: {
                enabled: true,
                bucket: "CHANGEME!",
                projectId: "",
                uploadPrefix: "outputs",
                uploadPaths: DEFAULT_GCS_UPLOAD_PATHS,
                cleanupAfterUpload: true
            },
            // Internal base for worker --webhook callbacks (private workers
            // cannot reach the public gateway hostname). Auto-detected from
            // the gateway metadata server when empty.
            webhookBaseUrl: "",
            dockerImage: "opendronemap/nodeodm",
            dockerMemory: "",
            dockerGpu: false,
            dockerRegistry: {
                url: "https://us-central1-docker.pkg.dev",
                useInstanceCredentials: true
            },
            nodeOnlineAttempts: DEFAULT_NODE_ONLINE_ATTEMPTS,
            nodeOnlineSleepMs: DEFAULT_NODE_ONLINE_SLEEP_MS
        }, userConfig);

        this._resolvedWebhookBase = null;
    }

    requiresDockerMachine(){
        return false;
    }

    createMachineClient(hostname){
        return new GceMachine(hostname, {
            project: this.getConfig("project"),
            zone: this.getConfigArrayItem("zone", 0)
        });
    }

    async initialize(){
        this.validateConfigKeys([
            "project",
            "serviceAccount",
            "gcs.bucket",
            "dockerImage"
        ]);

        const bucket = this.getConfig("gcs.bucket");
        const storage = new Storage(
            this.getConfig("gcs.projectId")
                ? {projectId: this.getConfig("gcs.projectId")}
                : undefined
        );
        // objectViewer can list/get objects but not buckets.get, so avoid exists().
        await storage.bucket(bucket).getFiles({maxResults: 1});
        logger.info(`Can access GCS bucket ${bucket} via ADC`);

        const mappings = this.getConfig("imageSizeMapping", []);
        if (!Array.isArray(mappings) || mappings.length === 0){
            throw new Error("Invalid config key imageSizeMapping (non-empty array expected)");
        }
        mappings.forEach(mapping => {
            if (!mapping.maxImages || !mapping.slug || !mapping.storage){
                throw new Error("Each imageSizeMapping entry requires maxImages, slug and storage");
            }
            (mapping.fallbacks || []).forEach(fallback => {
                if (!fallback.slug){
                    throw new Error("Each imageSizeMapping fallback requires a slug");
                }
            });
        });
        mappings.sort((a, b) => a.maxImages - b.maxImages);

        await this._resolveWebhookBase();
    }

    async _resolveWebhookBase(){
        const configured = this.getConfig("webhookBaseUrl", "");
        if (configured){
            this._resolvedWebhookBase = String(configured).replace(/\/+$/, "");
            return this._resolvedWebhookBase;
        }
        const ip = await fetchGatewayInternalIp();
        if (!ip){
            throw new Error(
                "webhookBaseUrl is empty and gateway internal IP could not be read from the metadata server. " +
                "Set webhookBaseUrl in the ASR config (e.g. http://10.x.x.x:3000)."
            );
        }
        this._resolvedWebhookBase = `http://${ip}:3000`;
        logger.info(`Worker webhook base: ${this._resolvedWebhookBase}`);
        return this._resolvedWebhookBase;
    }

    getDriverName(){
        return "gce";
    }

    // GCE names must match (?:[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?), but the base
    // implementation appends a mixed-case short id, which instances.insert
    // rejects outright.
    generateHostname(imagesCount){
        return super.generateHostname(imagesCount)
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-{2,}/g, "-")
            .slice(0, 63)
            .replace(/-+$/, "");
    }

    getMachinesLimit(){
        return this.getConfig("instanceLimit", -1);
    }

    getCreateRetries(){
        return this.getConfig("createRetries", 1);
    }

    getNodeOnlineAttempts(){
        return this.getConfig("nodeOnlineAttempts", DEFAULT_NODE_ONLINE_ATTEMPTS);
    }

    getNodeOnlineSleepMs(attempt){
        const base = this.getConfig("nodeOnlineSleepMs", DEFAULT_NODE_ONLINE_SLEEP_MS);
        return base;
    }

    getDownloadsBaseUrl(){
        const bucket = this.getConfig("gcs.bucket");
        return `https://${bucket}.storage.googleapis.com`;
    }

    canHandle(imagesCount){
        return this.getImagePropertiesFor(imagesCount) !== null;
    }

    getImagePropertiesFor(imagesCount){
        const mappings = this.getConfig("imageSizeMapping", []);
        for (let i = 0; i < mappings.length; i++){
            if (mappings[i].maxImages >= imagesCount) return mappings[i];
        }
        return null;
    }

    /**
     * Machine types a given job may run on, best first. A fallback inherits
     * storage/diskType from the primary and overrides only what differs.
     */
    getMachineVariantsFor(imagesCount){
        const base = this.getImagePropertiesFor(imagesCount);
        if (!base) return [];

        return [base].concat((base.fallbacks || []).map(fallback => {
            const merged = Object.assign({}, base, fallback);
            delete merged.fallbacks;
            return merged;
        }));
    }

    /**
     * Sweep every zone on one machine type before falling back to the next.
     * Stockouts hit a whole machine family across the region at once, so a
     * family change finds capacity when another zone won't.
     */
    getAttemptPlan(imagesCount, attempt){
        const variants = this.getMachineVariantsFor(imagesCount);
        if (!variants.length) throw new Error(`Cannot handle ${imagesCount} images.`);

        const zones = this.getConfigArray("zone");
        const idx = Math.max(0, attempt - 1);
        if (!zones.length) throw new Error("Config key zone must be a non-empty array");
        return {
            zone: zones[idx % zones.length],
            image: variants[Math.floor(idx / zones.length) % variants.length]
        };
    }

    getMaxRuntime(){
        return this.getConfig("maxRuntime", -1);
    }

    getMaxUploadTime(){
        return this.getConfig("maxUploadTime", -1);
    }

    workerWebhookUrl(token){
        const base = this._resolvedWebhookBase || this.getConfig("webhookBaseUrl");
        if (!base) throw new Error("webhookBaseUrl is not resolved");
        const url = new URL("/commit", base.endsWith("/") ? base : base + "/");
        if (token) url.search = new URLSearchParams({token}).toString();
        return url.toString();
    }

    /**
     * Metadata assembly only — COS workers start NodeODM from startup-script.
     * The dm argument is unused but kept for AbstractASRProvider.call signature.
     */
    async setupMachine(req, token, dm, nodeToken){
        // Spec is built in getInstanceSpec with these values already baked in.
        // Nothing to do over SSH.
        void req;
        void token;
        void dm;
        void nodeToken;
    }

    registryHost(){
        const url = this.getConfig("dockerRegistry.url", "https://us-central1-docker.pkg.dev");
        return String(url).replace(/^https?:\/\//, "").replace(/\/+$/, "");
    }

    async getInstanceSpec(imagesCount, attempt, hostname, req, token, nodeToken){
        const {image, zone} = this.getAttemptPlan(imagesCount, attempt);
        const dockerMemory = image.dockerMemory || this.getConfig("dockerMemory", "");
        const serviceAccountEmail = this.getConfig("serviceAccount");
        const emailOnly = serviceAccountEmail.includes("@")
            ? serviceAccountEmail
            : `${serviceAccountEmail}@${this.getConfig("project")}.iam.gserviceaccount.com`;

        if (!this._resolvedWebhookBase) await this._resolveWebhookBase();
        const webhook = this.workerWebhookUrl(token);

        const networkName = this.getConfig("network");
        const subnetworkName = this.getConfig("subnetwork");
        const project = this.getConfig("project");
        const networkInterface = {
            network: `projects/${project}/global/networks/${networkName}`
        };
        if (subnetworkName){
            const region = String(zone).replace(/-[a-z]$/, "");
            networkInterface.subnetwork =
                `projects/${project}/regions/${region}/subnetworks/${subnetworkName}`;
        }
        // No accessConfigs — private IP only; PGA covers AR + GCS.

        const diskType = image.diskType || this.getConfig("diskType");
        const machineImage = this.getConfig("machineImage") || COS_IMAGE;

        const metadataItems = [
            {key: "startup-script", value: buildWorkerStartupScript()},
            {key: "docker-image", value: this.getConfig("dockerImage")},
            {key: "docker-memory", value: dockerMemory || ""},
            {key: "node-token", value: nodeToken},
            {key: "webhook", value: webhook},
            {key: "gcs-bucket", value: this.getConfig("gcs.bucket")},
            {key: "gcs-project-id", value: this.getConfig("gcs.projectId") || ""},
            {key: "gcs-upload-prefix", value: this.getConfig("gcs.uploadPrefix", "outputs")},
            {key: "gcs-upload-paths", value: this.getConfig("gcs.uploadPaths", DEFAULT_GCS_UPLOAD_PATHS)},
            {key: "registry-host", value: this.registryHost()},
            {key: "enable-oslogin", value: "TRUE"}
        ];

        const spec = {
            name: hostname,
            zone,
            machineType: `zones/${zone}/machineTypes/${image.slug}`,
            disks: [{
                boot: true,
                autoDelete: true,
                initializeParams: {
                    sourceImage: machineImage,
                    diskSizeGb: String(image.storage),
                    diskType: `zones/${zone}/diskTypes/${diskType}`
                }
            }],
            networkInterfaces: [networkInterface],
            tags: {items: this.getConfigArray("tags")},
            serviceAccounts: [{
                email: emailOnly,
                scopes: this.getConfigArray("scopes")
            }],
            shieldedInstanceConfig: {
                enableSecureBoot: true,
                enableVtpm: true,
                enableIntegrityMonitoring: true
            },
            metadata: {items: metadataItems},
            scheduling: {
                preemptible: !!this.getConfig("preemptible"),
                automaticRestart: !this.getConfig("preemptible"),
                onHostMaintenance: this.getConfig("preemptible") ? "TERMINATE" : "MIGRATE"
            }
        };

        return spec;
    }

    // Retained for AbstractASRProvider debug helper / non-GCE path compatibility.
    async getCreateArgs(imagesCount, attempt){
        const {image, zone} = this.getAttemptPlan(imagesCount, attempt);
        return [
            "--project", this.getConfig("project"),
            "--zone", zone,
            "--machine-type", image.slug,
            "--disk-size", String(image.storage),
            "--no-address"
        ];
    }

    getFailureSleepTime(attempt){
        // Retry immediately while the ladder still has an untried zone/machine
        // type pair; back off only once the whole matrix has been swept.
        const variants = this.getConfig("imageSizeMapping", []).reduce(
            (max, m) => Math.max(max, 1 + (m.fallbacks || []).length), 1);
        const combinations = this.getConfigArray("zone").length * variants;

        return attempt <= combinations ? 1000 : 10000 * (attempt - combinations);
    }

    async destroyMachine(dmHostname){
        const project = this.getConfig("project");

        try{
            const zone = await new GceMachine(dmHostname, {project}).locateZone();
            if (!zone){
                logger.warn(`GCE instance ${dmHostname} not found in any zone, nothing to destroy`);
                return;
            }
            await new GceMachine(dmHostname, {project, zone}).rm(true);
            return;
        }catch(e){
            logger.warn(`Could not locate zone for ${dmHostname} (${e.message}), falling back to a per-zone sweep`);
        }

        // Never force here: a 404 must fall through to the next zone rather
        // than being reported as a successful delete.
        let lastErr = null;
        for (const zone of this.getConfigArray("zone")){
            try{
                await new GceMachine(dmHostname, {project, zone}).rm(false);
                return;
            }catch(e){
                lastErr = e;
                if (/not found|404/i.test(String(e.message || e))) continue;
                throw e;
            }
        }
        if (lastErr) logger.warn(`GCE instance ${dmHostname} not found in any configured zone`);
    }
};
