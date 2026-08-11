# Observability

The gateway ships structured events to Cloud Logging so a stuck upload can be
diagnosed without SSH. Every event lands in `jsonPayload` with an `event` field,
so you filter on fields rather than grepping text.

## Prerequisites

- `roles/logging.viewer` on the project (granted in helmut's
  `live/{dev,prod}/internal-tool/main.tf` via `ops_log_viewer_member`).
- The gateway container needs `GOOGLE_CLOUD_PROJECT` set; without it the
  Cloud Logging transport is skipped entirely and only the Console/File
  transports run.

Project and log name per environment:

| Environment | Project | Log name |
|-------------|---------|----------|
| dev | `asc-internal-tools-dev` | `projects/asc-internal-tools-dev/logs/clusterodm` |
| prod | `tools-471222` | `projects/tools-471222/logs/clusterodm` |

The gateway's own container stdout also arrives via the `gcplogs` Docker driver
under a different log name. That stream is unstructured; prefer the `clusterodm`
log for anything field-based.

## Events

A healthy upload emits, in order:

`task.init` → `task.upload.batch` (one per batch) → `task.commit.received` →
`task.commit.accepted` → `task.dispatch.start` → `task.dispatch.node` →
`task.commit.responded` → `task.routed`.

`task.dispatch.start` is emitted when the gateway begins the hand-off (before
the commit response returns). `task.dispatch.node` names the worker for both
static and autoscaled dispatches; for autoscaling it appears after the VM is
online, still before images are forwarded. `task.commit.responded` is tied to
the HTTP response finishing, so on a fast static dispatch it can land after
`.start` / `.node`.

| Event | Meaning |
|-------|---------|
| `task.init` | `/task/new/init` accepted; a tmp dir now exists |
| `task.upload.batch` | One upload batch settled; `batchCount` is the running total |
| `task.commit.received` | Commit request arrived |
| `task.commit.accepted` | Ledger claim won; this commit will dispatch |
| `task.commit.duplicate` | Already routed or already dispatching — the retry was absorbed |
| `task.commit.rejected` | Refused (deleted, canceled, over quota) |
| `task.commit.responded` | Response finished. `outcome` is `responded` or `aborted` |
| `task.dispatch.start` / `.node` | Hand-off begun; `.node` names the target (static and autoscale) |
| `task.forward.retry` | Upload to the worker failed and is being retried |
| `task.routed` | Worker owns the task; the gateway is now a proxy |
| `task.queued` | No capacity; waiting for a node |
| `task.dispatch.retained` | Persisted worker unreachable; claim held and re-probed rather than released |
| `task.dispatch.reset` | Dispatch recovery cleared a phase left behind by a restart |
| `task.recovered` | Orphan sweep found the task alive on a worker and healed the ledger |
| `task.orphaned` | Orphan sweep gave up and marked the task failed |
| `task.failed` | Task failed; `detail` carries the reason |
| `client.error` | A browser reported a failure via `POST /diag/client` |

Common fields: `taskId`, `actor` (email), `imagesCount`, `node`, `detail`,
`durationMs`, `outcome`.

## Queries

Set the project once:

```bash
export P=tools-471222   # or asc-internal-tools-dev
```

### Replay one task's whole life

The first thing to run when someone reports a stuck job.

```bash
gcloud logging read \
  "logName=\"projects/$P/logs/clusterodm\"
   AND jsonPayload.taskId=\"<uuid>\"" \
  --project="$P" --freshness=7d --order=asc \
  --format='table(timestamp, jsonPayload.event, jsonPayload.outcome, jsonPayload.detail)'
```

Read it against the healthy sequence above. Where it stops tells you the phase:

- stops after `task.upload.batch` — the commit never arrived, so the browser
  lost the connection before sending it. Look for a matching `client.error`.
- `task.commit.responded` with `outcome="aborted"` — the gateway did the work
  but the client never got the answer. This is the weekend incident: the retry
  logic now absorbs it and you should see a later `task.commit.duplicate`.
- stops after `task.dispatch.start` — the gateway died mid-dispatch. Dispatch
  recovery probes the persisted worker (host/port/token) at boot and on every
  sweep. If that worker still has the task it restores the route instead of
  releasing the claim. A claim is only released on proof — the worker answers
  that it does not have the task, or the job ages past `--orphan-timeout` — and
  that release is what emits `task.dispatch.reset`. An unreachable worker emits
  `task.dispatch.retained` instead and is asked again next pass, because
  releasing on a timeout is how a resume starts a duplicate run.

### Everything the alert fires on

```bash
gcloud logging read \
  "logName=\"projects/$P/logs/clusterodm\"
   AND jsonPayload.event=~\"task\..*failed|task\.orphaned|client\.error\"" \
  --project="$P" --freshness=1h --format=json
```

### Commits that the client never received

```bash
gcloud logging read \
  "logName=\"projects/$P/logs/clusterodm\"
   AND jsonPayload.event=\"task.commit.responded\"
   AND jsonPayload.outcome=\"aborted\"" \
  --project="$P" --freshness=7d \
  --format='table(timestamp, jsonPayload.taskId, jsonPayload.actor, jsonPayload.durationMs)'
```

A nonzero count here is expected and benign now — each one should be followed by
a successful retry. A rising count without matching `task.commit.duplicate`
events means the client-side retry is not working.

### Browser-reported failures

```bash
gcloud logging read \
  "logName=\"projects/$P/logs/clusterodm\"
   AND jsonPayload.event=\"client.error\"" \
  --project="$P" --freshness=24h \
  --format='table(timestamp, jsonPayload.actor, jsonPayload.phase, jsonPayload.status, jsonPayload.connection, jsonPayload.message)'
```

`phase` says where in the flow the browser was, `status=0` means the request
never reached the server, and `connection` carries the Network Information API
hint when the browser exposes it.

### One user's recent activity

```bash
gcloud logging read \
  "logName=\"projects/$P/logs/clusterodm\"
   AND jsonPayload.actor=\"someone@aspadeco.com\"" \
  --project="$P" --freshness=24h \
  --format='table(timestamp, jsonPayload.event, jsonPayload.taskId)'
```

### Caddy access logs

Caddy logs JSON to stdout, shipped by the `gcplogs` Docker driver into the
`gcplogs-docker-driver` log. Use this when ClusterODM has no record of a request
at all, to establish whether it reached the edge:

```bash
gcloud logging read \
  "logName=\"projects/$P/logs/gcplogs-docker-driver\"
   AND jsonPayload.container.name=\"/clusterodm-caddy\"
   AND jsonPayload.data:\"/task/new/commit\"" \
  --project="$P" --freshness=24h --format=json
```

Caddy's own JSON is nested inside `jsonPayload.data` as a string, so this is a
substring match, not a field match. Filter down by time and read the entries.

## Recovering a stranded upload

The browser handles the common case itself: it polls to see whether the commit
actually landed, retries with backoff, and offers Resume on the pending-uploads
banner. When that is not enough, use the admin CLI on the gateway:

```bash
gcloud compute ssh clusterodm-gateway-prod --tunnel-through-iap --project="$P"
docker exec -it clusterodm telnet localhost 8080
```

| Command | Purpose |
|---------|---------|
| `TASK PENDING` | Uploads with a tmp dir that never committed |
| `TASK RESUME <taskId>` | Commit a pending upload server-side |
| `TASK ORPHANS` | Non-terminal ledger rows with no live task and no route |

Uploads survive 72 hours on the gateway (`--tmp-max-age`), so a Friday failure
is still resumable Monday morning. `--stale-uploads-timeout` does not shorten
that: an upload whose job is in progress or failed is exempt from it, so only
the hard age cap ends the Resume window. The orphan sweeper runs at boot and
every 30 seconds, and only fails a job after `--orphan-timeout` hours (6 by
default) and only after probing the worker first.

## Alerting

helmut declares a log-based metric (`clusterodm/failure_events`) and an alert
policy in each internal-tool project — see `monitoring.tf` in
`live/{dev,prod}/internal-tool/`. It emails `alert_email` whenever a failure,
orphan, or client error appears. Notification channels cannot be shared across
projects, which is why each environment declares its own.

To verify the pipeline end to end, force a failure on dev (upload with
`--test_drop_uploads` on the reference node) and confirm both the log query and
the email.
