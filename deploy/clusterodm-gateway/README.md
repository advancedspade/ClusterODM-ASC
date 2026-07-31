# ClusterODM gateway runtime stack

Owned by **ClusterODM-ASC**. Deploys to Helmut-managed gateway VMs.

| Env | VM | Hostname | ASR file | Image tag |
|-----|-----|----------|----------|-----------|
| Dev | `clusterodm-gateway-dev` | `dev.drone.advancedspadecompany.com` | `gcp-asr.json` | `:dev` |
| Prod | `clusterodm-gateway-prod` | `drone.advancedspadecompany.com` | `gcp-asr.prod.json` | `:prod` |

## Services

- **caddy** — public HTTP/HTTPS and automatic TLS.
- **clusterodm** — public NodeODM-compatible API, task routing, and GCP ASR.
- **reference-node** — locked NodeODM-ASC instance that serves the custom UI,
  Google OAuth routes, `/options`, RTK, and custom GCS routes. It cannot receive
  normal processing tasks while locked.

## Who deploys what

| Change in | Workflow | Effect |
|-----------|----------|--------|
| ClusterODM-ASC | `deploy-gateway-dev.yml` / `deploy-gateway-prod.yml` | Build/push `clusterodm-asc`, sync this Compose stack, restart gateway |
| NodeODM-ASC (cluster path) | `publish-ar-nodeodm-dev.yml` / `publish-ar-nodeodm-prod.yml` | Build/push `nodeodm-asc`, refresh `reference-node` |
| NodeODM-ASC (legacy VMs) | existing `deploy-staging.yml` / `deploy-prod.yml` | Unchanged until cutover; still uses `gcr.io/tools-471222` |

Bootstrap order: publish NodeODM to AR first, then run the ClusterODM gateway
deploy (it refuses to start without the matching `nodeodm-asc` tag in AR).

## Images (Artifact Registry)

```text
# Dev
us-central1-docker.pkg.dev/asc-shared-services-dev/containers/clusterodm-asc:dev
us-central1-docker.pkg.dev/asc-shared-services-dev/containers/nodeodm-asc:dev

# Prod
us-central1-docker.pkg.dev/asc-shared-services/containers/clusterodm-asc:prod
us-central1-docker.pkg.dev/asc-shared-services/containers/nodeodm-asc:prod
```

## Outputs bucket

Public GCS buckets in consumer-app projects (Ayer reads via
`storage.googleapis.com`):

- Dev: `asc-nodeodm-outputs-dev` / `asc-consumer-apps-dev`
- Prod: `asc-nodeodm-outputs-prod` / `asc-consumer-apps`

`GCS_*` env vars for the reference node are derived from the ASR JSON at
deploy time.

## Deploy

| | Dev | Prod |
|---|---|---|
| GitHub Environment | `dev` | `prod` |
| Trigger branch | `dev` | `main` |
| Default hostname | `dev.drone.advancedspadecompany.com` | `drone.advancedspadecompany.com` |

Required secrets: `SESSION_SECRET`, `OAUTH_GOOGLE_CLIENT_ID`,
`OAUTH_GOOGLE_CLIENT_SECRET`, `REFERENCE_NODE_TOKEN`,
`CLUSTERODM_ADMIN_PASSWORD`. Do **not** share `SESSION_SECRET` across envs.

Optional vars: `GATEWAY_HOSTNAME`, `OAUTH_ALLOWED_DOMAINS`.

ASR config is committed (ADC only — no HMAC). Prod workflow copies
`gcp-asr.prod.json` → `gcp-asr.json` before upload. `remote-deploy.sh`
installs it under `/var/lib/clusterodm/secrets/`, fills `GATEWAY_INTERNAL_IP`
from the metadata server, and injects `webhookBaseUrl`.

## Persistence

Helmut mounts a separate 200 GB disk at `/var/lib/clusterodm`.

## Admin CLI

```bash
docker exec -it clusterodm telnet localhost 8080
```

## Validation without deployment

```bash
docker compose --env-file .env -f compose.yml config --quiet
```
