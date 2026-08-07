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
| Hostname | `dev.dronez.advancedspadecompany.com` | `dronez.advancedspadecompany.com` |
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
- Workers upload a curated `outputs/<sanitized-name>/` tree (orthophoto, DEM,
  report, meshes when present, tiles, sidecars). Intermediate `opensfm/` data
  and the raw `images/`/`gcp/` inputs (already uploaded at task start) are
  excluded. Workers pass `--gcs_skip_local_archive` so they do **not** build
  or upload `<task-uuid>/all.zip`.
- Post-teardown downloads are built on demand by the reference node from
  `outputs/<sanitized-name>/` (`GET /gcs/projects/<name>/archive`, or
  `/download?path=` for a single file). ClusterODM resolves the task UUID to
  that folder name via the job ledger and forwards the request.
- Worker container logs use `--log-driver=gcplogs` (worker SA has
  `roles/logging.logWriter`).

## Local task queue

When all `instanceLimit` worker slots are busy, `libs/taskNew.js` holds new
jobs in an in-memory FIFO queue on the gateway rather than failing with "No
nodes available". Queued jobs show up with NodeODM status code `10` (Queued)
in the UI and in `GET /task/<uuid>/info`, and can be canceled/removed like any
other task. The queue is dispatched:

- immediately after a worker VM is torn down (frees an `instanceLimit` slot),
- immediately after a failed autoscale attempt (frees a pending-creation slot), and
- on a 15s safety-net poll, in case neither hook fired.

The queue is in-memory only (like `tasktable`/`routetable`): it does not
survive a gateway restart, and uploaded files for queued jobs live under
`tmp/<uuid>/` until they're dispatched or canceled.

## Projects view and job history

Routing state is short-lived: a route is dropped when the worker VM is deleted,
and the task table lives only in memory. A separate ledger at
`data/jobs.json` on the gateway's mounted volume keeps durable job rows and
project archive metadata so both survive teardown and gateway restarts.

The NodeODM UI exposes a single **Projects** page that lists every folder
under `outputs/` in the bucket and joins it client-side with
`GET /task/history` by sanitized project name. Legacy jobs that predate the
ledger appear as folder-only rows (download / reprocess); tracked jobs show
status, actors, and events.

- Rows are keyed by task UUID. The creating account's hashed OAuth key
  (`oauth:<sha256(sub)>`) is stored for routing/attribution, and the signed-in
  email / Google subject are stored on each event so the team can see who
  worked on a job. Jobs started with the shared API token are attributed to
  `api` only.
- Status is normalized to `queued`, `running`, `succeeded`, `failed`,
  `canceled`, or `deleted`. A worker's `/commit` is authoritative and can
  correct an optimistic cancel; nothing else moves a settled job except an
  explicit restart. `deleted` is terminal.
- This is an internal tool: any authenticated user (domain-restricted OAuth)
  can list all jobs via `GET /task/history` and all live task IDs via
  `GET /task/list`. `include_deleted=0` hides deleted history rows.
- Archiving is keyed by sanitized GCS folder name rather than task UUID, so it
  works for every project, including folders created before the job ledger.
  Archive and restore actions are persisted in `data/jobs.json`; neither action
  changes **GCS outputs** under `outputs/<sanitized-name>/`.
- Removing or canceling a job whose worker is gone succeeds instead of failing
  with a routing error, and `GET /task/<uuid>/info` falls back to the ledger's
  last known outcome for any signed-in teammate.
- Reprocess sends `reprocessProject=true` through the gateway to the worker,
  allows reusing an existing folder name, and clears stale outputs (everything
  except `images/` and `gcp/`) only after the new run succeeds, right before
  the fresh upload.

History starts at deploy time; jobs that finished before this ledger existed
have no ledger row, but their `outputs/<name>/` folders still appear in the
Projects view.

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
- `imageSizeMapping`: first `maxImages` match selects machine/disk size. Each
  entry may list `fallbacks`, which inherit the entry's disk settings and
  override only what differs (typically `slug` and `dockerMemory`). Creation
  retries sweep every zone on one machine type before moving to the next
  fallback, because a stockout usually takes out a whole machine family across
  the region at once. Size `createRetries` to at least `zones × machine types`
  to give the ladder a full pass.
- `instanceLimit`: max concurrent worker VMs (`3`). Jobs submitted beyond this
  limit are held in an in-memory FIFO queue on the gateway (see below) instead
  of being rejected, and are dispatched to a worker as soon as one frees up.
  Raising this further is a quota question as much as a config one — check the
  project's regional CPU quota for the machine families in `imageSizeMapping`
  (each `c3-highmem-22` worker alone needs 22 vCPUs of `C3_CPUS`).
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
5. `gs://<bucket>/<uuid>/all.zip` is **not** created for new jobs.
6. `gs://<bucket>/outputs/<sanitized-name>/` contains the curated outputs
   (no `opensfm/`, no duplicate `images/`, no `all.zip`).
7. Anonymous `GET https://storage.googleapis.com/<bucket>/...` succeeds.
8. Worker instance is deleted after task completion.
9. `/task/<uuid>/download/all.zip` streams an on-demand zip built from
   `outputs/<sanitized-name>/`.
10. The job appears under Projects with the signing account; deleting it
    keeps the ledger row and leaves the bucket objects in place.
