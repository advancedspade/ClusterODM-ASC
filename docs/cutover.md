# Cutover: remove legacy staging/superdrone → ClusterODM prod

Do this only after dev e2e verification passes
([e2e-verification.md](./e2e-verification.md)).

End state: one prod ClusterODM gateway on `tools-471222`
(`clusterodm-gateway-prod`), writing to public
`asc-nodeodm-outputs-prod` in `asc-consumer-apps`. Legacy NodeODM
`staging` / `superdrone` VMs, their `gcr.io` image pipelines, and
`nodeodm-outputs-v1` (once Ayer is switched) are removed.

## Rollback posture

Keep the existing always-on super VM stopped (not deleted) until burn-in
completes. DNS is the cutover switch.

## Steps

1. Helmut already has the prod path:
   - `live/prod/consumer-app` → `asc-nodeodm-outputs-prod` (public)
   - `live/prod/internal-tool` → gateway + SAs + IAM on `tools-471222`
   Apply consumer-app then internal-tool if not already applied.
2. Configure GitHub Environment `prod` secrets (do **not** reuse the
   `dev` `SESSION_SECRET`).
3. Publish images and deploy:
   - NodeODM `publish-ar-nodeodm-prod.yml` (`:prod`)
   - ClusterODM `deploy-gateway-prod.yml` (uses `gcp-asr.prod.json`)
4. Smoke on the new VM IP with
   `Host: drone.advancedspadecompany.com` before moving DNS.
5. Point `drone.advancedspadecompany.com` at `clusterodm_gateway_ip`.
   Keep a short TTL ahead of the change. DNS only (grey cloud).
6. Point Ayer at `asc-nodeodm-outputs-prod` (separate change; Ayer still
   hardcodes `nodeodm-outputs-v1` until then).
7. Stop the legacy super and staging VMs. Do not delete disks or instances
   until burn-in ends.
8. After burn-in, decommission the legacy VMs, delete
   `deploy-staging.yml` / super deploy paths, and retire
   `gcr.io/tools-471222` if nothing else uses it.

## After cutover: external IP org policy

`compute.vmExternalIpAccess` is currently unenforced org-wide (dev and prod
match). Once ClusterODM workers are private-IP-only in prod and legacy VMs
are gone, enforce via `list_policies` with an explicit allowlist of
instances that still need public addresses (gateway, `shelby-ws`, etc.).
Prefer `allow_values` over the module's `deny_all` toggle.
