# Google Compute Engine autoscaling (ASC)

This fork adds a `gcp` autoscaling provider. ClusterODM remains online on a
small gateway VM and creates a NodeODM worker only after a task is committed.
The worker pulls the configured Docker image, processes one queued task, writes
durable results, calls ClusterODM's `/commit` webhook, and is deleted.

Use the Helmut **dev** internal-tools project first
(`asc-internal-tools-dev`). Promote equivalent IaC into prod only after
representative datasets have been processed. After cutover, the legacy
`tools-471222` staging/superdrone VMs are removed and only a prod replica of
this tested stack remains.

## Components

- ClusterODM-ASC gateway with Application Default Credentials (ADC).
- A locked NodeODM-ASC reference container on the gateway for the custom UI,
  `/options`, Google OAuth, GCS project APIs, and RTK APIs.
- Ephemeral private-IP-only Container-Optimized OS workers created via the
  Compute Engine REST API (no docker-machine, no SSH, no external IP).
- Dev GCS bucket `asc-nodeodm-outputs-dev` accessed with ADC:
  worker SA is `objectAdmin`, gateway SA is `objectViewer`.
- Workers upload both the portal `outputs/<sanitized-name>/` tree and a
  `<task-uuid>/all.zip` archive (`--gcs_task_archive`) for ClusterODM
  post-teardown downloads.
- Container images for the gateway and workers from
  `asc-shared-services-dev/containers` Artifact Registry (`:dev` tag). Legacy
  always-on NodeODM VMs continue to use `gcr.io/tools-471222` until cutover.

## Required IaC (Helmut)

Gateway compute lives in **`live/dev/internal-tool/`**
(`asc-internal-tools-dev`). The outputs bucket lives in
**`live/dev/shared-services/`** (`asc-shared-services-dev`). Bucket IAM for
the gateway/worker SAs is granted from the internal-tool stack.

1. Gateway service account:
   - permission to create, inspect and delete worker instances/disks;
   - permission to use the worker service account;
   - `roles/storage.objectViewer` on the outputs bucket;
   - no long-lived service-account key (the gateway uses ADC).
2. Worker service account:
   - read access to the NodeODM-ASC image in Artifact Registry;
   - `roles/storage.objectAdmin` on `asc-nodeodm-outputs-dev`.
3. Firewall rules:
   - gateway tag → worker tag TCP `3000`;
   - worker tag → gateway tag TCP `3000` (internal `/commit` webhook).
4. Dev GCS bucket `asc-nodeodm-outputs-dev`. Production continues using
   `nodeodm-outputs-v1` until cutover.
5. HTTPS ingress for `dev.drone.advancedspadecompany.com`.

Workers have **no external IP**. Artifact Registry and GCS are reached over
Private Google Access on the subnet. The gateway keeps a reserved public IP
for HTTPS; workers call back on the gateway's internal IP:3000.

## Gateway configuration

ClusterODM's main config enables cookie-session validation:

```json
{
  "cloud-provider": "ascOAuth",
  "session-secret": "same value used by the reference NodeODM-ASC",
  "oauth-cookie-name": "ndm_oauth",
  "oauth-allowed-domains": "aspadeco.com",
  "public-address": "https://dev.drone.advancedspadecompany.com",
  "asr": "/run/secrets/gcp-asr.json"
}
```

Prefer the `SESSION_SECRET`, `OAUTH_COOKIE_NAME`, and
`OAUTH_ALLOWED_DOMAINS` environment variables over putting secrets in this
file.

Compose publishes ClusterODM port 3000 on `GATEWAY_INTERNAL_IP` so private
workers can reach `/commit`. `remote-deploy.sh` fills that IP from the
metadata server and injects `webhookBaseUrl` into the ASR config.

The reference NodeODM-ASC must:

- use the same `SESSION_SECRET`;
- set its Google redirect URI to the public ClusterODM hostname;
- run with `TRUST_PROXY=1`;
- be registered in ClusterODM and **locked**;
- not be reachable from the public internet except through ClusterODM.

ClusterODM forwards public UI/OAuth routes and protected `/gcs/*`, `/rtk/*`,
and `/option-ui-defaults` routes to that locked reference node. Task routes stay
inside ClusterODM and are assigned to ephemeral workers.

## ASR configuration

`deploy/clusterodm-gateway/gcp-asr.json` is committed (no secrets). See also
`docs/gcp-asr.example.json`.

Important fields:

- `project`: `asc-internal-tools-dev` for dev.
- `zone`: one or more zones; retries rotate through them.
- `serviceAccount`: service account attached to worker VMs.
- `machineImage`: COS family (`projects/cos-cloud/global/images/family/cos-stable`).
- `imageSizeMapping`: first `maxImages` match selects machine/disk size.
- `instanceLimit`: `1` initially, so no more than one ephemeral worker can run
  at a time.
- `maxRuntime`: hard worker lifetime in seconds (vacuum runs every 10 minutes).
- `maxUploadTime`: removes workers that never receive a task successfully.
- `dockerImage`: NodeODM-ASC image from shared-services Artifact Registry
  (`:dev`).
- `gcs.bucket`: `asc-nodeodm-outputs-dev` in `asc-shared-services-dev`.
- `webhookBaseUrl`: filled on the gateway at deploy time
  (`http://<gateway-internal-ip>:3000`). When empty, ClusterODM reads the
  gateway internal IP from the metadata server at startup.

## Org policy constraints this design respects

- `iam.disableServiceAccountKeyCreation` — no HMAC / SA keys.
- `compute.requireOsLogin` — no docker-machine metadata SSH keys.
- `compute.requireShieldedVm` — workers set all three shielded options.
- `storage.uniformBucketLevelAccess` — no object ACLs.

## Validation checklist

After Helmut apply + gateway deploy:

1. Worker instance has no `accessConfigs` / external IP.
2. All three shielded options are enabled on the worker.
3. Artifact Registry pull succeeds over Private Google Access.
4. Worker `/commit` lands on the gateway internal IP.
5. `gs://asc-nodeodm-outputs-dev/<uuid>/all.zip` exists.
6. `gs://asc-nodeodm-outputs-dev/outputs/<sanitized-name>/` shape is unchanged.
7. Worker instance is deleted after task completion.
