"use strict";

const assert = require("assert");
const jwt = require("jsonwebtoken");
const Node = require("../libs/classes/Node");
const GCPAsrProvider = require("../libs/asr-providers/gcp");
const AscOAuthCloudProvider = require("../libs/cloud-providers/AscOAuthCloudProvider");
const config = require("../config");

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-minimum!!";

async function testRoutes(){
    const routes = require("../libs/ascUiRoutes");
    assert.strictEqual(routes.isPublicUiPath("/"), true);
    assert.strictEqual(routes.isPublicUiPath("/login.html"), true);
    assert.strictEqual(routes.isPublicUiPath("/auth/google/callback"), true);
    assert.strictEqual(routes.isPublicUiPath("/css/app.css"), true);
    assert.strictEqual(routes.isPublicUiPath("/task/new"), false);
    assert.strictEqual(routes.isProtectedReferencePath("/gcs/status"), true);
    assert.strictEqual(routes.isProtectedReferencePath("/rtk/run"), true);
    assert.strictEqual(routes.isProtectedReferencePath("/task/new"), false);
}

async function testAscOAuth(){
    const provider = new AscOAuthCloudProvider();
    process.env.OAUTH_ALLOWED_DOMAINS = "aspadeco.com,advancedspadecompany.com";

    const ok = jwt.sign(
        {email: "pilot@aspadeco.com"},
        process.env.SESSION_SECRET,
        {subject: "google-sub-123", expiresIn: "1h"}
    );
    const valid = await provider.validate(ok, {headers: {}});
    assert.strictEqual(valid.valid, true);
    assert.ok(valid.token.indexOf("oauth:") === 0);

    const internal = jwt.verify(valid.accessToken, process.env.SESSION_SECRET);
    assert.strictEqual(internal.sub, "google-sub-123");
    assert.strictEqual(internal.purpose, "cluster-internal");

    const renewed = jwt.sign(
        {email: "pilot@aspadeco.com"},
        process.env.SESSION_SECRET,
        {subject: "google-sub-123", expiresIn: "2h"}
    );
    const renewedResult = await provider.validate(renewed, {headers: {}});
    assert.strictEqual(renewedResult.token, valid.token, "routing owner must survive JWT renewal");

    const denied = jwt.sign(
        {email: "outsider@example.com"},
        process.env.SESSION_SECRET,
        {subject: "outsider", expiresIn: "1h"}
    );
    assert.strictEqual((await provider.validate(denied, {headers: {}})).valid, false);
    assert.strictEqual((await provider.validate("bad-token", {headers: {}})).valid, false);

    config.token = "trusted-api-token";
    const api = await provider.validate("trusted-api-token", {headers: {}});
    assert.strictEqual(api.valid, true);
    assert.ok(api.token.indexOf("api:") === 0);
    config.token = "";
}

async function testGcpProvider(){
    const provider = new GCPAsrProvider();
    provider.config.project = "tools-dev";
    provider.config.serviceAccount = "worker@tools-dev.iam.gserviceaccount.com";
    provider.config.gcs.bucket = "results-bucket";
    provider.config.gcs.projectId = "shared-dev";
    provider.config.dockerImage = "us-central1-docker.pkg.dev/asc-shared-services-dev/containers/nodeodm-asc:dev";
    provider.config.dockerRegistry.url = "https://us-central1-docker.pkg.dev";
    provider.config.network = "internal-tools-vpc";
    provider.config.subnetwork = "internal-tools-us-central1";
    provider.config.webhookBaseUrl = "http://10.0.0.5:3000";
    provider._resolvedWebhookBase = "http://10.0.0.5:3000";

    assert.strictEqual(provider.requiresDockerMachine(), false);
    assert.strictEqual(provider.getDownloadsBaseUrl(), "https://results-bucket.storage.googleapis.com");
    assert.strictEqual(
        provider.workerWebhookUrl("oauth-owner"),
        "http://10.0.0.5:3000/commit?token=oauth-owner"
    );
    assert.strictEqual(
        provider.workerWebhookUrl("a&b=c d"),
        "http://10.0.0.5:3000/commit?token=a%26b%3Dc+d"
    );

    const args = await provider.getCreateArgs(700, 1);
    assert.ok(args.indexOf("--no-address") !== -1);
    assert.ok(args.indexOf("n2-highmem-16") !== -1);

    const spec = await provider.getInstanceSpec(
        700,
        1,
        "clusterodm-700-test",
        {headers: {host: "cluster.example.com"}},
        "oauth-owner",
        "worker-token"
    );

    assert.strictEqual(spec.name, "clusterodm-700-test");
    assert.strictEqual(spec.zone, "us-central1-a");
    assert.ok(spec.machineType.indexOf("n2-highmem-16") !== -1);
    assert.strictEqual(spec.networkInterfaces[0].accessConfigs, undefined);
    assert.strictEqual(spec.shieldedInstanceConfig.enableSecureBoot, true);
    assert.strictEqual(spec.shieldedInstanceConfig.enableVtpm, true);
    assert.strictEqual(spec.shieldedInstanceConfig.enableIntegrityMonitoring, true);
    assert.ok(spec.disks[0].initializeParams.sourceImage.indexOf("cos-stable") !== -1);

    const meta = {};
    spec.metadata.items.forEach(item => { meta[item.key] = item.value; });
    assert.ok(meta["startup-script"].indexOf("docker-credential-gcr") !== -1);
    assert.ok(meta["startup-script"].indexOf("--gcs_task_archive") !== -1);
    assert.strictEqual(meta["docker-image"], provider.config.dockerImage);
    assert.strictEqual(meta["node-token"], "worker-token");
    assert.strictEqual(meta["gcs-bucket"], "results-bucket");
    assert.ok(meta.webhook.indexOf("http://10.0.0.5:3000/commit") === 0);
    assert.strictEqual(meta["docker-memory"], "112g");
    assert.strictEqual(meta["registry-host"], "us-central1-docker.pkg.dev");

    const client = provider.createMachineClient("clusterodm-700-test");
    assert.strictEqual(client.machineName, "clusterodm-700-test");
    assert.strictEqual(client.project, "tools-dev");
}

async function testStorageObjectKey(){
    const utils = require("../libs/utils");
    const taskId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    assert.strictEqual(utils.storageObjectKey(taskId, "all.zip"), `${taskId}/all.zip`);
    assert.strictEqual(
        utils.storageObjectKey(taskId, "odm_orthophoto/odm_orthophoto.tif"),
        `${taskId}/odm_orthophoto/odm_orthophoto.tif`
    );

    // Traversal must stay inside the task prefix.
    [
        "../other-task/all.zip",
        "..//other-task/all.zip",
        "foo/../../other-task/all.zip",
        "./../outputs/secret.tif"
    ].forEach(assetPath => {
        const key = utils.storageObjectKey(taskId, assetPath);
        assert.ok(key.startsWith(`${taskId}/`), `${assetPath} escaped the task prefix: ${key}`);
        assert.strictEqual(key.indexOf(".."), -1);
    });

    assert.strictEqual(utils.storageObjectKey(taskId, ".."), null);
    assert.strictEqual(utils.storageObjectKey(taskId, "/"), null);
    assert.strictEqual(utils.storageObjectKey(taskId, ""), null);
}

async function testReferenceNodeTokenRotation(){
    const node = new Node("reference-node", 3000, "old-token");
    node.setToken("new-token");
    node.setLocked(true);
    assert.strictEqual(node.getToken(), "new-token");
    assert.strictEqual(node.isLocked(), true);
}

(async function(){
    await testRoutes();
    await testAscOAuth();
    await testGcpProvider();
    await testStorageObjectKey();
    await testReferenceNodeTokenRotation();
    console.log("All tests passed");
})().catch(err => {
    console.error(err.stack || err);
    process.exit(1);
});
