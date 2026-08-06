# Local stack: ClusterODM gateway in front of NodeODM

Runs the ASC fork of ClusterODM (`docker-compose.local.yml`, port 3000) as the
OAuth-protected front for a local NodeODM (`../NodeODM-ASC`, port 4000). Use this
to exercise Google sign-in, the Projects view, and project archiving end to end.

Assumes both repos are checked out side by side under the same parent directory.

## Layout

- **NodeODM** (`../NodeODM-ASC`, port 4000): serves the UI, performs the Google
  OAuth handshake, and signs the `ndm_oauth` cookie.
- **ClusterODM** (this repo, port 3000): the entry point you open in the browser.
  Proxies to NodeODM, verifies the cookie, and tracks jobs/archives.

Two values must match across the repos or every request reads as logged-out /
offline:

| Value                | NodeODM (`docker-compose.dev.yml` / `.env`) | ClusterODM (`docker-compose.local.yml` / `.env`) |
| -------------------- | ------------------------------------------- | ------------------------------------------------ |
| Session secret       | `SESSION_SECRET` (in `.env`)                | `SESSION_SECRET` (in `.env`)                     |
| Reference node token | `NODEODM_TOKEN`                             | `REFERENCE_NODE_TOKEN`                            |

## One-time setup

1. **NodeODM `.env`** (`../NodeODM-ASC/.env`) — OAuth credentials, allowed
   domain, and a session secret:

   ```
   OAUTH_GOOGLE_CLIENT_ID=<web client id>.apps.googleusercontent.com
   OAUTH_GOOGLE_CLIENT_SECRET=<client secret>
   OAUTH_GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
   OAUTH_ALLOWED_DOMAINS=aspadeco.com
   SESSION_SECRET=<openssl rand -hex 32>
   # Optional, to browse/upload real GCS projects:
   GCS_BUCKET=asc-nodeodm-outputs-dev
   GCS_PROJECT_ID=asc-consumer-apps-dev
   GCS_UPLOAD_PREFIX=outputs
   ```

   The redirect URI points at the gateway (port 3000), and that exact URL must be
   an authorized redirect URI on the Google OAuth client.

2. **ClusterODM `.env`** (this repo) — the same session secret, kept out of git:

   ```
   cp .env.example .env
   # set SESSION_SECRET to the identical value used in NodeODM-ASC/.env
   ```

3. **GCS credentials** (only if you set `GCS_*` above) — Application Default
   Credentials on the host:

   ```
   gcloud auth application-default login
   ```

## Run

Start NodeODM first (the gateway health-probes it on boot), then the gateway.

```bash
# 1) NodeODM on :4000  (add the gcs-adc overlay only if using GCS)
cd ../NodeODM-ASC
docker compose -f docker-compose.dev.yml -f docker-compose.gcs-adc.yml up --build -d

# 2) Gateway on :3000
cd ../ClusterODM-ASC
docker compose -f docker-compose.local.yml up --build
```

Open http://localhost:3000 and sign in with an `@aspadeco.com` Google account.

## Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/login.html          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/task/history         # 401 (no cookie) is expected
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:4000/info?token=local-reference-node-token'  # 200
```

## Troubleshooting

- **Every gateway page returns 503.** The reference node is unreachable — usually
  `NODEODM_TOKEN` (NodeODM) and `REFERENCE_NODE_TOKEN` (gateway) disagree, or
  NodeODM isn't up on 4000. The gateway logs `Cannot update info for
  host.docker.internal:4000: Request failed with status code 401`.
- **Signed in but treated as logged out on the gateway.** `SESSION_SECRET`
  differs between the two `.env` files. NodeODM signs the cookie; the gateway
  verifies it with its own secret.
- **`redirect_uri_mismatch` from Google.** `OAUTH_GOOGLE_REDIRECT_URI` must be
  `http://localhost:3000/auth/google/callback` and be authorized on the OAuth
  client. Use `localhost` consistently (not `127.0.0.1`).
- **Login loops / cookie dropped after callback.** Local origins are http, so the
  cookie can't be `Secure`; `docker-compose.dev.yml` sets `OAUTH_COOKIE_SECURE=0`.
- **"Cloud storage is not connected."** ADC expired — re-run
  `gcloud auth application-default login` and recreate the NodeODM container with
  `--force-recreate`.

## Running NodeODM standalone (no gateway)

To work on NodeODM alone without OAuth, skip the gateway and disable login:

```bash
cd ../NodeODM-ASC
docker compose -f docker-compose.dev.yml -f docker-compose.no-oauth.yml up
```
