# Google Compute Engine autoscaling (ASC)

This fork adds a `gcp` autoscaling provider. ClusterODM remains online on a
small gateway VM and creates a NodeODM worker only after a task is committed.
The worker pulls the configured Docker image, processes one queued task, writes
durable results, calls ClusterODM's `/commit` webhook, and is deleted.

## Environments

| | Dev | Prod |
|---|---|---|
| Gateway project | `asc-internal-tools-dev` | `tools-471222` |
| Gateway VM | `clusterodm-gateway-dev` | `clusterodm-gateway-prod` |
| Hostname | `dev.drone.advancedspadecompany.com` | `drone.advancedspadecompany.com` |
| Outputs bucket | `asc-nodeodm-outputs-dev` in `asc-consumer-apps-dev` | `asc-nodeodm-outputs-prod` in `asc-consumer-apps` |
| Images | `asc-shared-services-dev/containers` `:dev` | `asc-shared-services/containers` `:prod` |
| ASR file | `gcp-asr.json` | `gcp-asr.prod.json` |

Outputs buckets are **public** (`allUsers` objectViewer) so Ayer and Mapbox GL
can fetch orthophoto TMS tiles from `storage.googleapis.com`. Legacy
`nodeodm-outputs-v1` stays until Ayer is pointed at the prod bucket.

## Components

- ClusterODM-ASC gateway with Application Default Credentials (ADC).
- A locked NodeODM-ASC reference container on the gateway for the custom UI,
  `/options`, Google OAuth, GCS project APIs, and RTK APIs.
- Ephemeral private-IP-only Container-Optimized OS workers created via the
  Compute Engine REST API (no docker-machine, no SSH, no external IP).
- Public GCS outputs bucket accessed with ADC for writes:
  worker SA is `objectAdmin` + `legacyBucketReader`, gateway SA is
  `objectUser` + `legacyBucketReader`.
- Workers upload both the portal `outputs/<sanitized-name>/` tree and a
  `<task-uuid>/all.zip` archive (`--gcs_task_archive`) for ClusterODM
  post-teardown downloads.
- Worker container logs use `--log-driver=gcplogs` (worker SA has
  `roles/logging.logWriter`).

## Job history

Routing state is short-lived: a route is dropped when the worker VM is deleted,
and the task table lives only in memory. A separate ledger at
`data/jobs.json` on the gateway's mounted volume keeps one durable row per job
so users still see an outcome after teardown or a gateway restart.

- Rows are keyed by task UUID and owned by the same hashed OAuth key used for
  routing (`oauth:<sha256(sub)>`), so history is per-account. The signed-in
  email and Google subject are stored alongside each event for attribution;
  jobs started with the shared API token are attributed to `api` only.
- Status is normalized to `queued`, `running`, `succeeded`, `failed`,
  `canceled`, or `deleted`. A worker's `/commit` is authoritative and can
  correct an optimistic cancel; nothing else moves a settled job except an
  explicit restart. `deleted` is terminal.
- `GET /task/history` returns the caller's rows, newest first, with their audit
  events. `include_deleted=0` hides deleted rows. `GET /task/list` is unchanged.
- Deleting a job is a soft delete: the row stays and records who removed it.
  Worker cleanup still runs, and **GCS outputs are preserved** — neither
  `outputs/<sanitized-name>/` nor `<task-uuid>/all.zip` is touched.
- Removing or canceling a job whose worker is gone succeeds instead of failing
  with a routing error, and `GET /task/<uuid>/info` falls back to the ledger's
  last known outcome.

History starts at deploy time; jobs that finished before this ledger existed
have no row and are not recoverable, though they can still be dismissed from
the UI.

## Required IaC (Helmut)

- Gateway compute: `live/dev/internal-tool/` or `live/prod/internal-tool/`
- Outputs bucket: `live/dev/consumer-app/` or `live/prod/consumer-app/`
- Artifact Registry: `live/*/shared-services/`
- Bucket IAM for gateway/worker SAs is granted from the internal-tool stack.

Workers have **no external IP**. Artifact Registry and GCS are reached over
Private Google Access on the subnet. The gateway keeps a reserved public IP
for HTTPS; workers call back on the gateway's internal IP:3000.

## ASR configuration

`deploy/clusterodm-gateway/gcp-asr.json` (dev) and `gcp-asr.prod.json` (prod)
are committed (no secrets). See also `docs/gcp-asr.example.json`.

Important fields:

- `project`: gateway/worker project.
- `zone`: one or more zones; retries rotate through them.
- `serviceAccount`: service account attached to worker VMs.
- `machineImage`: COS family (`projects/cos-cloud/global/images/family/cos-stable`).
- `imageSizeMapping`: first `maxImages` match selects machine/disk size.
- `instanceLimit`: `1` initially.
- `dockerImage`: NodeODM-ASC image from shared-services Artifact Registry.
- `gcs.bucket` / `gcs.projectId`: consumer-app public outputs bucket.
- `webhookBaseUrl`: filled on the gateway at deploy time
  (`http://<gateway-internal-ip>:3000`).

## Org policy constraints this design respects

- `iam.disableServiceAccountKeyCreation` — no HMAC / SA keys.
- `compute.requireOsLogin` — no docker-machine metadata SSH keys.
- `compute.requireShieldedVm` — workers set all three shielded options.
- `storage.uniformBucketLevelAccess` — no object ACLs.
- Public bucket reads use the consumer-app project
  `iam.allowedPolicyMemberDomains` override (same as Ayer media).

## Validation checklist

After Helmut apply + gateway deploy:

1. Worker instance has no `accessConfigs` / external IP.
2. All three shielded options are enabled on the worker.
3. Artifact Registry pull succeeds over Private Google Access.
4. Worker `/commit` lands on the gateway internal IP.
5. `gs://<bucket>/<uuid>/all.zip` exists.
6. `gs://<bucket>/outputs/<sanitized-name>/` shape is unchanged.
7. Anonymous `GET https://storage.googleapis.com/<bucket>/...` succeeds.
8. Worker instance is deleted after task completion.
9. The job appears under Job history with the signing account, and deleting it
   there keeps the row and leaves the bucket objects in place.
