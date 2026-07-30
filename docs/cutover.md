# Cutover: remove legacy staging/superdrone → ClusterODM prod

Do this only after dev e2e verification passes
([e2e-verification.md](./e2e-verification.md)).

End state: one prod ClusterODM gateway (mirror of the tested Helmut `dev`
stack). Legacy NodeODM `staging` and `superdrone` VMs, their `gcr.io` image
pipelines, and the GitHub Environment `staging` are removed.

## Rollback posture

Keep the existing always-on super VM stopped (not deleted) until burn-in
completes. DNS is the cutover switch.

## Steps

1. Mirror Helmut `live/dev/internal-tool` + shared-services bucket/IAM into
   the production path.
2. Deploy production gateway Compose + images (prod equivalents of
   `deploy-gateway-dev.yml` / `publish-ar-nodeodm-dev.yml`, Environment
   `prod`, tag `:prod`).
3. Point the public drone hostname (today `superdrone.advancedspadecompany.com`,
   or the chosen prod name) at the new gateway address. Keep a short TTL
   ahead of the change.
4. Stop the legacy super and staging VMs. Do not delete disks or instances
   until burn-in ends.
5. Smoke-test: login, small job, large job, download, portal
   `outputs/<sanitized-name>/` layout.
6. After burn-in, decommission the legacy VMs, delete
   `deploy-staging.yml` / super deploy paths, and retire
   `gcr.io/tools-471222` if nothing else uses it.

## After cutover: external IP org policy

`compute.vmExternalIpAccess` is currently unenforced org-wide (dev and prod
match). Once ClusterODM workers are private-IP-only in prod and legacy VMs
are gone, enforce via `list_policies` with an explicit allowlist of
instances that still need public addresses (gateway, `shelby-ws`, etc.).
Prefer `allow_values` over the module's `deny_all` toggle.
