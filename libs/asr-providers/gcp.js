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

docker-credential-gcr configure-docker --registries="\${REGISTRY_HOST}"

ARGS=(run -d --name nodeodm -p 3000:3000 --restart unless-stopped)
if [[ -n "\${DOCKER_MEMORY}" ]]; then
  ARGS+=(--memory="\${DOCKER_MEMORY}" --memory-swap="\${DOCKER_MEMORY}")
fi
ARGS+=("\${DOCKER_IMAGE}" -q 1)
ARGS+=(--gcs_bucket "\${GCS_BUCKET}")
if [[ -n "\${GCS_PROJECT_ID}" ]]; then
  ARGS+=(--gcs_project_id "\${GCS_PROJECT_ID}")
fi
ARGS+=(--gcs_upload_prefix "\${GCS_UPLOAD_PREFIX:-outputs}")
ARGS+=(--gcs_upload_paths "\${GCS_UPLOAD_PATHS:-.}")
ARGS+=(--gcs_cleanup_after_upload)
ARGS+=(--gcs_task_archive)
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
            createRetries: 3,
            imageSizeMapping: [
                {maxImages: 800, slug: "n2-highmem-16", storage: 500, dockerMemory: "112g"},
                {maxImages: 5000, slug: "n2-highmem-32", storage: 1000, dockerMemory: "224g"}
            ],
            gcs: {
                enabled: true,
                bucket: "CHANGEME!",
                projectId: "",
                uploadPrefix: "outputs",
                uploadPaths: ".",
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
        if (token) url.search = `token=${token}`;
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
        const image = this.getImagePropertiesFor(imagesCount);
        const zone = this.getConfigArrayItem("zone", attempt - 1);
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
            {key: "gcs-upload-paths", value: this.getConfig("gcs.uploadPaths", ".")},
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
        const image = this.getImagePropertiesFor(imagesCount);
        return [
            "--project", this.getConfig("project"),
            "--zone", this.getConfigArrayItem("zone", attempt - 1),
            "--machine-type", image.slug,
            "--disk-size", String(image.storage),
            "--no-address"
        ];
    }

    getFailureSleepTime(attempt){
        const zones = this.getConfigArray("zone").length;
        return attempt <= zones ? 1000 : 10000 * (attempt - zones);
    }

    async destroyMachine(dmHostname){
        const zones = this.getConfigArray("zone");
        let lastErr = null;
        for (const zone of zones){
            const dm = new GceMachine(dmHostname, {
                project: this.getConfig("project"),
                zone
            });
            try{
                await dm.rm(true);
                return;
            }catch(e){
                lastErr = e;
                if (/not found|404/i.test(String(e.message || e))) continue;
            }
        }
        if (lastErr) throw lastErr;
    }
};
