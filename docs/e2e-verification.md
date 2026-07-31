# ClusterODM dev end-to-end verification

Run after Helmut apply (consumer-app bucket → internal-tool) and both CI
workflows (`publish-ar-nodeodm-dev.yml`, then `deploy-gateway-dev.yml`).

## Preconditions

- `https://dev.drone.advancedspadecompany.com/login.html` serves the
  NodeODM-ASC UI after Google OAuth.
- ASR config is mounted at `/run/secrets/gcp-asr.json` with
  `webhookBaseUrl` set to `http://<gateway-internal-ip>:3000`.
- `asc-nodeodm-outputs-dev` exists in `asc-consumer-apps-dev` (public);
  worker SA is objectAdmin, gateway SA is objectUser.

## Small dataset

1. Sign in and create a task with a small image set (< 800 images so the
   worker maps to `n2-highmem-16`).
2. Confirm a worker appears:

   ```bash
   gcloud compute instances list \
     --project=asc-internal-tools-dev \
     --filter='name~^clusterodm- AND tags.items=clusterodm-worker'
   ```

3. On that instance, verify:

   ```bash
   gcloud compute instances describe INSTANCE \
     --project=asc-internal-tools-dev --zone=ZONE \
     --format='yaml(networkInterfaces[0].accessConfigs,shieldedInstanceConfig)'
   ```

   Expected: `accessConfigs` absent/empty; all three shielded flags `true`.

4. After completion:

   ```bash
   gsutil ls gs://asc-nodeodm-outputs-dev/<task-uuid>/all.zip
   gsutil ls gs://asc-nodeodm-outputs-dev/outputs/<sanitized-name>/
   ```

5. Confirm the worker is deleted and
   `/task/<uuid>/download/all.zip` streams through the gateway.

## Large dataset

Repeat with a set that maps to `n2-highmem-32` (`maxImages` > 800). Confirm
machine type, disk size, and docker memory from the ASR mapping.

## Failure signals

- Worker with an external IP → ASR still attaching `accessConfigs`.
- `/commit` never arrives → firewall or `webhookBaseUrl` / port bind wrong.
- AR pull fails → Private Google Access or worker AR reader IAM.
- Download 404 after teardown → missing `--gcs_task_archive` or gateway
  objectViewer.
