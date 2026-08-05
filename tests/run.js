"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const jwt = require("jsonwebtoken");
const Node = require("../libs/classes/Node");
const GCPAsrProvider = require("../libs/asr-providers/gcp");
const AscOAuthCloudProvider = require("../libs/cloud-providers/AscOAuthCloudProvider");
const config = require("../config");

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-minimum!!";

function tempHistoryFile(){
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clusterodm-history-")), "jobs.json");
}

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
    assert.ok(args.indexOf("c3-highmem-22") !== -1);

    // Retry ladder: exhaust every zone on one machine type before falling back.
    provider.config.zone = ["us-central1-a", "us-central1-b"];
    const ladder = [1, 2, 3, 4, 5, 6, 7].map(attempt => {
        const plan = provider.getAttemptPlan(700, attempt);
        return `${plan.image.slug}@${plan.zone}`;
    });
    assert.deepStrictEqual(ladder, [
        "c3-highmem-22@us-central1-a",
        "c3-highmem-22@us-central1-b",
        "n2-highmem-16@us-central1-a",
        "n2-highmem-16@us-central1-b",
        "n2d-highmem-16@us-central1-a",
        "n2d-highmem-16@us-central1-b",
        "c3-highmem-22@us-central1-a"
    ]);

    // Fallbacks inherit disk settings and override only what differs.
    const fallback = provider.getAttemptPlan(700, 3).image;
    assert.strictEqual(fallback.dockerMemory, "112g");
    assert.strictEqual(fallback.storage, 500);
    assert.strictEqual(fallback.fallbacks, undefined);

    // Back off only once the whole zone/machine-type matrix has been swept.
    assert.strictEqual(provider.getFailureSleepTime(6), 1000);
    assert.strictEqual(provider.getFailureSleepTime(7), 10000);

    provider.config.zone = ["us-central1-a"];

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
    assert.ok(spec.machineType.indexOf("c3-highmem-22") !== -1);
    assert.strictEqual(spec.networkInterfaces[0].accessConfigs, undefined);
    assert.strictEqual(spec.shieldedInstanceConfig.enableSecureBoot, true);
    assert.strictEqual(spec.shieldedInstanceConfig.enableVtpm, true);
    assert.strictEqual(spec.shieldedInstanceConfig.enableIntegrityMonitoring, true);
    assert.ok(spec.disks[0].initializeParams.sourceImage.indexOf("cos-stable") !== -1);

    const meta = {};
    spec.metadata.items.forEach(item => { meta[item.key] = item.value; });
    assert.ok(meta["startup-script"].indexOf("docker-credential-gcr") !== -1);
    assert.ok(meta["startup-script"].indexOf("--gcs_skip_local_archive") !== -1);
    assert.ok(meta["startup-script"].indexOf("--gcs_task_archive") === -1);
    assert.strictEqual(meta["docker-image"], provider.config.dockerImage);
    assert.strictEqual(meta["node-token"], "worker-token");
    assert.strictEqual(meta["gcs-bucket"], "results-bucket");
    assert.ok(meta.webhook.indexOf("http://10.0.0.5:3000/commit") === 0);
    assert.strictEqual(meta["docker-memory"], "154g");
    assert.strictEqual(meta["registry-host"], "us-central1-docker.pkg.dev");

    const client = provider.createMachineClient("clusterodm-700-test");
    assert.strictEqual(client.machineName, "clusterodm-700-test");
    assert.strictEqual(client.project, "tools-dev");
}

async function testStorageObjectKey(){
    const utils = require("../libs/utils");
    const taskId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    assert.strictEqual(utils.isTaskUuid(taskId), false, "version nibble must be 1-5");
    assert.strictEqual(utils.isTaskUuid("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), true);
    assert.strictEqual(utils.isTaskUuid("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee; rm -rf /"), false);
    assert.strictEqual(utils.isTaskUuid("../tmp"), false);
    assert.strictEqual(utils.isTaskUuid(""), false);
    assert.strictEqual(utils.isTaskUuid(null), false);

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

async function testJobHistoryLedger(){
    const jobHistory = require("../libs/jobHistory");
    const statusCodes = require("../libs/statusCodes");
    const file = tempHistoryFile();
    const pilot = {source: "oauth", sub: "sub-1", email: "pilot@aspadeco.com"};

    await jobHistory.initialize(file);

    await jobHistory.record("job-1", "created", {
        ownerKey: "oauth:owner-a",
        actor: pilot,
        name: "North field",
        imagesCount: 120,
        status: jobHistory.STATUS.QUEUED
    });
    await jobHistory.record("job-1", "routed", {status: jobHistory.STATUS.RUNNING});
    await jobHistory.record("job-1", "finished", {statusCode: statusCodes.COMPLETED, force: true});

    let job = await jobHistory.lookup("job-1");
    assert.strictEqual(job.status, jobHistory.STATUS.SUCCEEDED);
    assert.strictEqual(job.statusCode, statusCodes.COMPLETED);
    assert.deepStrictEqual(job.createdBy, pilot);

    // A duplicate webhook must not walk a finished job back to running.
    await jobHistory.record("job-1", "finished", {statusCode: statusCodes.RUNNING, force: true});
    job = await jobHistory.lookup("job-1");
    assert.strictEqual(job.status, jobHistory.STATUS.SUCCEEDED, "duplicate commit must not regress status");

    // Canceling an already finished job leaves the outcome alone.
    await jobHistory.record("job-1", "canceled", {status: jobHistory.STATUS.CANCELED});
    assert.strictEqual((await jobHistory.lookup("job-1")).status, jobHistory.STATUS.SUCCEEDED);

    // A cancel recorded while running is corrected by the worker's result.
    await jobHistory.record("job-2", "created", {ownerKey: "oauth:owner-a", status: jobHistory.STATUS.QUEUED});
    await jobHistory.record("job-2", "routed", {status: jobHistory.STATUS.RUNNING});
    await jobHistory.record("job-2", "canceled", {status: jobHistory.STATUS.CANCELED});
    assert.strictEqual((await jobHistory.lookup("job-2")).status, jobHistory.STATUS.CANCELED);
    await jobHistory.record("job-2", "finished", {statusCode: statusCodes.COMPLETED, force: true});
    assert.strictEqual((await jobHistory.lookup("job-2")).status, jobHistory.STATUS.SUCCEEDED);

    // Owner is still stored for attribution, but listing is org-wide.
    await jobHistory.record("job-3", "created", {ownerKey: "oauth:owner-b", status: jobHistory.STATUS.QUEUED});
    const ownerAJobs = await jobHistory.findByOwner("oauth:owner-a");
    assert.deepStrictEqual(ownerAJobs.map(j => j.uuid).sort(), ["job-1", "job-2"]);
    assert.deepStrictEqual((await jobHistory.findByOwner("oauth:owner-b")).map(j => j.uuid), ["job-3"]);
    assert.deepStrictEqual(
        (await jobHistory.list()).map(j => j.uuid).sort(),
        ["job-1", "job-2", "job-3"]
    );

    // Soft delete keeps the row and records who did it.
    const remover = {source: "oauth", sub: "sub-2", email: "lead@aspadeco.com"};
    const finishedAtBeforeDelete = (await jobHistory.lookup("job-1")).finishedAt;
    assert.ok(finishedAtBeforeDelete > 0);
    await jobHistory.record("job-1", "deleted", {actor: remover, status: jobHistory.STATUS.DELETED});
    job = await jobHistory.lookup("job-1");
    assert.strictEqual(job.status, jobHistory.STATUS.DELETED);
    assert.ok(job.deletedAt > 0);
    assert.strictEqual(job.finishedAt, finishedAtBeforeDelete, "delete must not overwrite completion time");
    assert.ok(job.deletedAt >= finishedAtBeforeDelete);
    assert.strictEqual(job.lastUpdatedBy.email, remover.email);
    assert.strictEqual(job.lastUpdatedBy.action, "deleted");
    assert.ok(job.events.some(e => e.action === "created" && e.actor && e.actor.email === pilot.email));
    assert.ok(job.events.some(e => e.action === "deleted" && e.actor && e.actor.email === remover.email));

    // Deleting a never-finished job still stamps finishedAt once.
    await jobHistory.record("job-delete-only", "created", {ownerKey: "oauth:owner-a", status: jobHistory.STATUS.QUEUED});
    await jobHistory.record("job-delete-only", "deleted", {status: jobHistory.STATUS.DELETED});
    const deletedOnly = await jobHistory.lookup("job-delete-only");
    assert.strictEqual(deletedOnly.finishedAt, deletedOnly.deletedAt);

    // Deletion is terminal, even against an authoritative late webhook.
    await jobHistory.record("job-1", "finished", {statusCode: statusCodes.COMPLETED, force: true});
    assert.strictEqual((await jobHistory.lookup("job-1")).status, jobHistory.STATUS.DELETED);

    assert.deepStrictEqual(
        (await jobHistory.findByOwner("oauth:owner-a", {includeDeleted: false})).map(j => j.uuid),
        ["job-2"],
        "deleted rows must be filterable"
    );
    assert.strictEqual((await jobHistory.findByOwner("oauth:owner-a")).length, 3, "deleted rows are retained");

    // Restart revives a failed job.
    await jobHistory.record("job-4", "created", {ownerKey: "oauth:owner-a", status: jobHistory.STATUS.QUEUED});
    await jobHistory.record("job-4", "failed", {status: jobHistory.STATUS.FAILED, detail: "no nodes available"});
    await jobHistory.record("job-4", "restarted", {status: jobHistory.STATUS.RUNNING, allowRevive: true});
    assert.strictEqual((await jobHistory.lookup("job-4")).status, jobHistory.STATUS.RUNNING);

    // Survives a restart of the gateway.
    await jobHistory.saveToDisk();
    await jobHistory.initialize(file);
    const reloaded = await jobHistory.lookup("job-1");
    assert.strictEqual(reloaded.status, jobHistory.STATUS.DELETED);
    assert.strictEqual(reloaded.name, "North field");
    assert.strictEqual(reloaded.imagesCount, 120);
    assert.strictEqual((await jobHistory.findByOwner("oauth:owner-a")).length, 4);

    const taskInfo = jobHistory.toTaskInfo(await jobHistory.lookup("job-2"));
    assert.strictEqual(taskInfo.uuid, "job-2");
    assert.strictEqual(taskInfo.status.code, statusCodes.COMPLETED);
    assert.strictEqual(taskInfo.progress, 100);

    assert.deepStrictEqual(await jobHistory.ownership("job-1", "oauth:owner-a"), {found: true, owned: true});
    assert.deepStrictEqual(await jobHistory.ownership("job-1", "oauth:owner-b"), {found: true, owned: false});
    assert.deepStrictEqual(await jobHistory.ownership("unknown-job", "oauth:owner-a"), {found: false, owned: false});
}

// Removing a finished job used to fail with "no nodes in routing table" once the
// worker VM was gone, leaving a row the user could not dismiss.
async function testRemoveWithoutRoute(){
    const jobHistory = require("../libs/jobHistory");
    const LocalCloudProvider = require("../libs/cloud-providers/LocalCloudProvider");

    let proxy = null;
    try{
        proxy = require("../libs/proxy");
    }catch(e){
        // node-libcurl ships a prebuilt binding; a dev machine whose
        // node_modules were installed for another architecture cannot load the
        // proxy at all. Run `npm test` in the Docker image to cover this.
        if (String(e.message).indexOf("node_libcurl.node") === -1) throw e;
        console.log("SKIP testRemoveWithoutRoute: node-libcurl binding unavailable on this architecture");
        return;
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clusterodm-proxy-"));
    fs.mkdirSync(path.join(workDir, "data"));
    fs.mkdirSync(path.join(workDir, "tmp"));

    const originalCwd = process.cwd();
    const originalToken = config.token;
    config.token = "";
    process.chdir(workDir);

    let server = null;
    try{
        const servers = await proxy.initialize(new LocalCloudProvider());
        server = servers[0].server;
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const port = server.address().port;

        const request = (method, urlPath, body) => {
            return new Promise((resolve, reject) => {
                const payload = body === undefined ? null : Buffer.from(body);
                const req = http.request({
                    host: "127.0.0.1",
                    port,
                    path: urlPath,
                    method,
                    headers: payload ? {
                        "Content-Type": "multipart/form-data; boundary=----t",
                        "Content-Length": payload.length
                    } : {}
                }, res => {
                    let data = "";
                    res.on("data", c => { data += c; });
                    res.on("end", () => {
                        try{
                            resolve({statusCode: res.statusCode, body: JSON.parse(data)});
                        }catch(e){
                            reject(new Error(`Bad JSON from ${urlPath}: ${data}`));
                        }
                    });
                });
                req.on("error", reject);
                if (payload) req.write(payload);
                req.end();
            });
        };

        const removeBody = (uuid) =>
            `------t\r\nContent-Disposition: form-data; name="uuid"\r\n\r\n${uuid}\r\n------t--\r\n`;

        const legacyTask = "11111111-1111-4111-8111-111111111111";
        const finishedTask = "22222222-2222-4222-8222-222222222222";

        // Predates the ledger: nothing to update, but the client must be able
        // to drop the row instead of seeing a routing error.
        const unknown = await request("POST", "/task/remove?token=owner-a", removeBody(legacyTask));
        assert.strictEqual(unknown.body.success, true, `expected success, got ${JSON.stringify(unknown.body)}`);

        await jobHistory.record(finishedTask, "created", {
            ownerKey: "owner-a",
            actor: {source: "oauth", sub: "s", email: "pilot@aspadeco.com"},
            name: "Finished job",
            status: jobHistory.STATUS.QUEUED
        });
        await jobHistory.record(finishedTask, "finished", {statusCode: 40, force: true});

        // The worker is gone, so info falls back to the durable outcome.
        const info = await request("GET", `/task/${finishedTask}/info?token=owner-a`);
        assert.strictEqual(info.body.status.code, 40, `expected durable status, got ${JSON.stringify(info.body)}`);
        assert.strictEqual(info.body.name, "Finished job");

        const removed = await request("POST", "/task/remove?token=owner-a", removeBody(finishedTask));
        assert.strictEqual(removed.body.success, true, `expected success, got ${JSON.stringify(removed.body)}`);
        assert.strictEqual((await jobHistory.lookup(finishedTask)).status, jobHistory.STATUS.DELETED);

        // Removal is idempotent.
        const again = await request("POST", "/task/remove?token=owner-a", removeBody(finishedTask));
        assert.strictEqual(again.body.success, true);
        assert.strictEqual((await jobHistory.lookup(finishedTask)).status, jobHistory.STATUS.DELETED);

        // Another teammate can see and soft-delete the same job; actor is recorded.
        const sharedTask = "33333333-3333-4333-8333-333333333333";
        await jobHistory.record(sharedTask, "created", {
            ownerKey: "owner-a",
            actor: {source: "oauth", sub: "s", email: "pilot@aspadeco.com"},
            name: "Shared job",
            status: jobHistory.STATUS.QUEUED
        });
        await jobHistory.record(sharedTask, "finished", {statusCode: 40, force: true});

        const teammateInfo = await request("GET", `/task/${sharedTask}/info?token=owner-b`);
        assert.strictEqual(teammateInfo.body.status.code, 40, `teammates must see durable status, got ${JSON.stringify(teammateInfo.body)}`);

        const teammateRemove = await request("POST", "/task/remove?token=owner-b", removeBody(sharedTask));
        assert.strictEqual(teammateRemove.body.success, true, `expected teammate remove success, got ${JSON.stringify(teammateRemove.body)}`);
        assert.strictEqual((await jobHistory.lookup(sharedTask)).status, jobHistory.STATUS.DELETED);

        const history = await request("GET", "/task/history?token=owner-b");
        const historyIds = history.body.jobs.map(j => j.uuid);
        assert.ok(historyIds.indexOf(finishedTask) !== -1);
        assert.ok(historyIds.indexOf(sharedTask) !== -1);
        const sharedRow = history.body.jobs.find(j => j.uuid === sharedTask);
        assert.strictEqual(sharedRow.createdBy.email, "pilot@aspadeco.com");

        const withoutDeleted = await request("GET", "/task/history?token=owner-a&include_deleted=0");
        assert.deepStrictEqual(withoutDeleted.body.jobs, []);

        // Restart cannot be honored without a node, and says so.
        const restart = await request("POST", "/task/restart?token=owner-a", removeBody(finishedTask));
        assert.ok(restart.body.error && restart.body.error.indexOf("no longer available") !== -1,
                  `expected restart guidance, got ${JSON.stringify(restart.body)}`);
    }finally{
        if (server) await new Promise(resolve => server.close(resolve));
        process.chdir(originalCwd);
        config.token = originalToken;
    }
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
    await testJobHistoryLedger();
    await testRemoveWithoutRoute();
    console.log("All tests passed");

    // The proxy's housekeeping intervals keep the event loop alive.
    process.exit(0);
})().catch(err => {
    console.error(err.stack || err);
    process.exit(1);
});
