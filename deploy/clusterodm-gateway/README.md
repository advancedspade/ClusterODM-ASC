# ClusterODM gateway runtime stack

Owned by **ClusterODM-ASC**. Deploys to the Helmut-managed
`clusterodm-gateway-dev` VM.

## Services

- **caddy** — public HTTP/HTTPS and automatic TLS.
- **clusterodm** — public NodeODM-compatible API, task routing, and GCP ASR.
- **reference-node** — locked NodeODM-ASC instance that serves the custom UI,
  Google OAuth routes, `/options`, RTK, and custom GCS routes. It cannot receive
  normal processing tasks while locked.

## Who deploys what

| Change in | Workflow | Effect |
|-----------|----------|--------|
| ClusterODM-ASC | `deploy-gateway-dev.yml` | Build/push `clusterodm-asc`, sync this Compose stack, restart gateway |
| NodeODM-ASC (cluster path) | `publish-ar-nodeodm-dev.yml` | Build/push `nodeodm-asc`, refresh `reference-node` on the existing gateway |
| NodeODM-ASC (legacy VMs) | existing `deploy-staging.yml` / `deploy-prod.yml` | Unchanged until cutover; still uses `gcr.io/tools-471222` |

Bootstrap order: publish NodeODM to AR first, then run the ClusterODM gateway
deploy (it refuses to start without `nodeodm-asc:dev` in AR).

## Images (Artifact Registry)

```text
us-central1-docker.pkg.dev/asc-shared-services-dev/containers/clusterodm-asc:dev
us-central1-docker.pkg.dev/asc-shared-services-dev/containers/nodeodm-asc:dev
```

## Deploy (ClusterODM)

GitHub Environment: `dev`. Trigger branch: `dev`.

Required secrets: `SESSION_SECRET`, `OAUTH_GOOGLE_CLIENT_ID`,
`OAUTH_GOOGLE_CLIENT_SECRET`, `REFERENCE_NODE_TOKEN`,
`CLUSTERODM_ADMIN_PASSWORD`.

Optional vars: `GATEWAY_HOSTNAME` (default
`dev.drone.advancedspadecompany.com`), `OAUTH_ALLOWED_DOMAINS`,
`PORTAL_SUPER_ENV_URL`.

ASR config is the committed [`gcp-asr.json`](./gcp-asr.json) (ADC only — no
HMAC secrets). `remote-deploy.sh` installs it under
`/var/lib/clusterodm/secrets/`, fills `GATEWAY_INTERNAL_IP` from the metadata
server, and injects `webhookBaseUrl` so private workers can call `/commit`.

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
