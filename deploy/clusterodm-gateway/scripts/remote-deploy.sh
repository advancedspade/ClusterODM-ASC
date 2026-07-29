#!/usr/bin/env bash
# Runs on the gateway VM. Expects /opt/clusterodm to already contain compose
# files, .env, and gcp-asr.json.
set -euo pipefail

OPT_DIR="${OPT_DIR:-/opt/clusterodm}"
SECRETS_DIR="${SECRETS_DIR:-/var/lib/clusterodm/secrets}"

cd "${OPT_DIR}"

if [[ ! -f compose.yml ]]; then
  echo "Missing ${OPT_DIR}/compose.yml" >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo "Missing ${OPT_DIR}/.env" >&2
  exit 1
fi
if [[ ! -f gcp-asr.json ]]; then
  echo "Missing ${OPT_DIR}/gcp-asr.json" >&2
  exit 1
fi

install -d -m 0755 "${SECRETS_DIR}"
install -m 0640 -o 1000 -g 1000 gcp-asr.json "${SECRETS_DIR}/gcp-asr.json"

GATEWAY_INTERNAL_IP="$(curl -fsS -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/ip)"

if grep -q '^GATEWAY_INTERNAL_IP=' .env; then
  sed -i "s|^GATEWAY_INTERNAL_IP=.*|GATEWAY_INTERNAL_IP=${GATEWAY_INTERNAL_IP}|" .env
else
  echo "GATEWAY_INTERNAL_IP=${GATEWAY_INTERNAL_IP}" >> .env
fi

if grep -q '^ASR_CONFIG_PATH=' .env; then
  sed -i 's|^ASR_CONFIG_PATH=.*|ASR_CONFIG_PATH=/run/secrets/gcp-asr.json|' .env
else
  echo 'ASR_CONFIG_PATH=/run/secrets/gcp-asr.json' >> .env
fi

# Inject webhookBaseUrl into the ASR config so workers call the internal IP.
python3 - "${SECRETS_DIR}/gcp-asr.json" "${GATEWAY_INTERNAL_IP}" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
ip = sys.argv[2]
data = json.loads(path.read_text())
data["webhookBaseUrl"] = f"http://{ip}:3000"
path.write_text(json.dumps(data, indent=4) + "\n")
PY

# shellcheck disable=SC1091
set -a
# shellcheck disable=SC1091
source .env
set +a

AR_HOST="${AR_HOST:-us-central1-docker.pkg.dev}"
gcloud auth configure-docker "${AR_HOST}" --quiet

docker compose --env-file .env -f compose.yml config --quiet
docker compose --env-file .env -f compose.yml pull
docker compose --env-file .env -f compose.yml up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

echo "Waiting for Caddy/ClusterODM health..."
ok=0
for _ in $(seq 1 30); do
  if curl -fsS -H "Host: ${GATEWAY_HOSTNAME}" "http://127.0.0.1/login.html" >/dev/null 2>&1; then
    ok=1
    break
  fi
  if docker compose --env-file .env -f compose.yml exec -T clusterodm \
      curl -fsS "http://127.0.0.1:3000/login.html" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 5
done

if [[ "${ok}" != "1" ]]; then
  echo "Local health check failed. Compose status:" >&2
  docker compose --env-file .env -f compose.yml ps >&2 || true
  docker compose --env-file .env -f compose.yml logs --tail=80 >&2 || true
  exit 1
fi

echo "Gateway deploy complete (internal webhook base http://${GATEWAY_INTERNAL_IP}:3000)"
