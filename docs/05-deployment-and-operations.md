# Deployment and Operations

## Deployment Topologies

`hq-jr` runs as one of three deployment shapes:

| Topology | Status | Notes |
| :--- | :--- | :--- |
| **Released container on a Linux host** | Reference deployment | Pulls `ghcr.io/adi-il/hq-jr` and runs it under Docker Compose. The volt-rust host uses this shape with a 15-minute update timer. |
| **Google Cloud Run** | Alternative | Requires a public webhook ingress, a service account with Vertex AI access, and durable storage for SQLite if you scale beyond one instance. |
| **Local development** | Development only | Runs from source, normally with a Smee.io tunnel for webhooks and host ADC for Vertex AI. |

The container is the recommended production shape. It ships the Node runtime, production dependencies, `tini`, and the Probot daemon, so the host needs Docker and Compose, not Node.js.

## Published Container (GHCR)

Each release publishes two tags to GitHub Container Registry:

```bash
docker pull ghcr.io/adi-il/hq-jr:latest
```

To pin a build, use its image digest (`ghcr.io/adi-il/hq-jr@sha256:...`). Tags can move; digests cannot.

The image runs as the unprivileged `hqjr` user (uid/gid `1001`), exposes port `3000`, and starts Probot through `tini`:

```text
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["probot", "run", "./dist/index.js"]
```

The image is the App daemon. It is separate from the npm global CLI (`npm i -g hq-jr`), which exposes only `health`, `review`, and `sandbox-test`.

Each release also attaches `hq-jr-<version>-linux-amd64.tar.gz` to the [GitHub Release](https://github.com/adi-IL/hq-jr/releases).

## Release Pipeline (Maintainers)

Pushes to `master` or `main` run `.github/workflows/release.yml` unless the commit message contains `[skip release]`:

1. Install dependencies, typecheck, and test.
2. Compute the next patch version as `patch(max(package.json version, npm latest))`.
3. Build with `NODE_ENV=production`.
4. Publish to npm.
5. Push the version commit and tag, retrying with a rebase if `master` moved during the run. The tag stays on the published commit.
6. Build and push the GHCR image with the version tag and `latest`.
7. Create the GitHub Release with the Docker tarball asset.

Required repository secret:

| Secret | Purpose |
| :--- | :--- |
| `NPM_TOKEN` | npm publish token. |

`GITHUB_TOKEN` is automatic and provides `contents: write` and `packages: write` for the tag push, GitHub Release, and GHCR push.

Version rules and the publish-before-push ordering live in `.github/workflows/release.yml`. The tag push retries three times. If all attempts fail, the run pushes a `release-recovery/<tag>` branch and uploads the version commit patch as an artifact, then prints the recovery details; it never republishes.

## Reference Deployment: GHCR + Docker Compose

The reference host is a Linux VM running Docker. The repository ships the deployment files under [`deploy/`](../deploy/):

| File | Purpose |
| :--- | :--- |
| `deploy/compose.yaml` | Container definition: image, env file, data volume, ADC mount, port, healthcheck, log rotation. |
| `deploy/update.sh` | Reads the image from compose, pulls it, compares image IDs, recreates only on change, health-checks, and rolls back to the previous image if the new one fails. |
| `deploy/hq-jr-update.service` | Oneshot systemd unit that runs `update.sh`. |
| `deploy/hq-jr-update.timer` | Runs the update unit every 15 minutes. |

### Prerequisites

1. Docker Engine with the Compose v2 plugin.
2. A GitHub App (`APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`) and a Vertex AI project.
3. ADC on the host, either:
   - a GCE VM service account with the Vertex AI scope, or
   - an ADC JSON file such as `~/.config/gcloud/application_default_credentials.json`.
4. A deploy user that can run Docker, normally via membership in the `docker` group. The reference unit runs as `adi-IL`; change `User`/`Group` in `deploy/hq-jr-update.service` on other hosts.

### Setup

1. Place the deployment on the host. The reference layout is `/opt/hq-jr`:

   ```bash
   sudo mkdir -p /opt/hq-jr
   sudo chown "$USER":"$USER" /opt/hq-jr
   git clone https://github.com/adi-IL/hq-jr.git /opt/hq-jr
   ```

2. Create `/opt/hq-jr/.env` from `.env.example`. At minimum:

   ```dotenv
   APP_ID=123456
   PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
   WEBHOOK_SECRET=your_webhook_secret
   GOOGLE_CLOUD_PROJECT=your-gcp-project-id
   GOOGLE_CLOUD_LOCATION=global
   HQ_JR_DB_PATH=/app/data/hq-jr.db
   ```

   Keep `PRIVATE_KEY` on one line with escaped `\n` characters. Do not put spaces around `=`.

   ```bash
   chmod 600 /opt/hq-jr/.env
   ```

3. Create the data directory. The container runs as uid `1001`, so that user must own the directory:

   ```bash
   mkdir -p /opt/hq-jr/data
   sudo chown -R 1001:1001 /opt/hq-jr/data
   ```

4. Stage ADC. The container runs as uid `1001` and only needs the ADC JSON file:

   ```bash
   sudo install -d -m 700 -o 1001 -g 1001 /opt/hq-jr/gcloud
   sudo install -m 400 -o 1001 -g 1001 \
     ~/.config/gcloud/application_default_credentials.json \
     /opt/hq-jr/gcloud/
   ```

   `deploy/compose.yaml` mounts `/opt/hq-jr/gcloud` at `/gcloud` and sets `GOOGLE_APPLICATION_CREDENTIALS=/gcloud/application_default_credentials.json`. Mounting the dedicated directory keeps unrelated host credentials out of the container. On a GCE VM whose service account has the Vertex AI scope, remove that mount and the `GOOGLE_APPLICATION_CREDENTIALS` variable.

5. Start the service:

   ```bash
   cd /opt/hq-jr/deploy
   docker compose up -d
   ```

6. Verify health and logs:

   ```bash
   curl -fsS http://127.0.0.1:3000/livez
   curl -fsS http://127.0.0.1:3000/healthz
   docker compose logs --tail=50
   ```

7. Install the update timer:

   ```bash
   sudo cp /opt/hq-jr/deploy/hq-jr-update.service /opt/hq-jr/deploy/hq-jr-update.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now hq-jr-update.timer
   ```

### Compose Behavior

The reference `deploy/compose.yaml` does the following:

- Runs `ghcr.io/adi-il/hq-jr:latest` as container `hq-jr`.
- Loads `/opt/hq-jr/.env` through `env_file`.
- Forces `HOST=0.0.0.0` inside the container and `NODE_ENV=production`. The `.env` file can keep `HOST=127.0.0.1`; Compose overrides it.
- Publishes only `127.0.0.1:3000` on the host. Put a reverse proxy or tunnel in front if GitHub must reach the webhook endpoint directly.
- Mounts `/opt/hq-jr/data` at `/app/data` for SQLite.
- Mounts `/opt/hq-jr/gcloud` at `/gcloud` for ADC. The directory should contain only `application_default_credentials.json` and be readable by uid `1001`.
- Health-checks `http://127.0.0.1:3000/livez` from inside the container every 30 seconds with a 6-second timeout. The probe aborts after 4 seconds.
- Rotates JSON logs at 10 MB with three files.

The image user is `hqjr` (`1001:1001`), not root. The data directory must remain writable by uid `1001`.

### Upgrades and Rollback

The update timer runs every 15 minutes. `deploy/update.sh` reads the image reference from the compose file, pulls it, compares the running image ID with the pulled image ID, recreates the container only when they differ, and polls `/livez` until a 60-second deadline. If the new container stays unhealthy, the script restores the previous image when one exists and exits non-zero. It records the failed digest in `deploy/.last-failed-image` and skips that digest until a new image is published.

Manual upgrade:

```bash
cd /opt/hq-jr/deploy
docker compose pull
docker compose up -d
```

Update log:

```bash
sudo journalctl -u hq-jr-update.service -n 50 --no-pager
```

Rollback: stop the update timer if you want to freeze automatic updates.

```bash
sudo systemctl stop hq-jr-update.timer
```

Pin the previous version in `deploy/compose.yaml` and recreate the container:

```yaml
image: ghcr.io/adi-il/hq-jr:0.1.6
```

```bash
cd /opt/hq-jr/deploy
docker compose up -d
```

The updater reads the image from compose, so it respects the pin while the timer is active. Re-enable the timer after removing the pin:

```bash
sudo systemctl start hq-jr-update.timer
```

Back up the database before a rollback that crosses schema changes.

### Data Persistence and Backup

The image defaults `HQ_JR_DB_PATH` to `/app/data/hq-jr.db`. The reference host mounts `/opt/hq-jr/data`, so the database lives at `/opt/hq-jr/data/hq-jr.db` and survives container replacement.

SQLite runs in WAL mode. Stop the container before copying the files:

```bash
docker stop hq-jr
sudo cp -a /opt/hq-jr/data "/opt/hq-jr/data.bak-$(date +%F-%H%M)"
docker start hq-jr
```

Restore by stopping the container, replacing the contents of `/opt/hq-jr/data` from a backup, restoring ownership to uid `1001`, and starting the container.

## Webhook Ingress

The GitHub App sends webhooks to the URL configured in its settings. The endpoint is `/api/github/webhooks`.

- **Direct ingress.** Terminate TLS at a reverse proxy and point the GitHub App at `https://your-host/api/github/webhooks`. Publish or proxy port `3000`. Keep `WEBHOOK_SECRET` identical on both sides.
- **Smee tunnel.** For hosts without public ingress, set `WEBHOOK_PROXY_URL` to a Smee channel and set the GitHub App webhook URL to the same channel. The container connects outbound; no inbound port is required.

`app.yml` contains a Smee placeholder (`https://smee.io/your_smee_channel_id`). Replace it before registering the app, or update the App settings after registration.

## Alternative: Google Cloud Run

Cloud Run works if you provide public HTTPS ingress, a service account with Vertex AI access, and durable storage:

```bash
gcloud run deploy hq-jr \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=your-google-cloud-project-id,GOOGLE_CLOUD_LOCATION=global,LOG_LEVEL=info,HQ_JR_DB_PATH=/app/data/hq-jr.db" \
  --set-secrets "APP_ID=HQ_JR_APP_ID:latest,PRIVATE_KEY=HQ_JR_PRIVATE_KEY:latest,WEBHOOK_SECRET=HQ_JR_WEBHOOK_SECRET:latest"
```

Cloud Run caveats:

- The container filesystem is ephemeral. Mount a persistent volume or accept per-instance state. Review findings, active run locks, remediation markers, and Tier 3 poll recovery need durable storage.
- Cloud Run request timeout is up to 60 minutes. Long Tier 3 polls can outlive a request; the SQLite recovery path resumes stale sandbox jobs on startup.
- Scale-to-zero drops the Smee tunnel and any in-memory state. Use direct webhook ingress for Cloud Run.

## Local Development

1. Install dependencies and build:

   ```bash
   npm ci
   npm run build
   ```

2. Create `.env` from `.env.example`. For local webhooks, set `WEBHOOK_PROXY_URL` to a Smee channel and set the GitHub App webhook URL to the same channel.

3. Start the App daemon:

   ```bash
   npm start
   ```

   `npm start` runs `probot run ./dist/index.js`. The `npm run dev` script only watches `src/index.ts`; it does not start the Probot server.

4. Authenticate to Vertex AI with host ADC:

   ```bash
   gcloud auth application-default login
   gcloud config set project <PROJECT_ID>
   ```

For CLI-only checks without the webhook server:

```bash
npm i -g hq-jr
hq-jr health
hq-jr review --diff ./change.diff
hq-jr review --pr 42 --repo owner/repo
hq-jr sandbox-test --repo https://github.com/owner/repo --branch main --cmd "npm test"
```

## Environment Variables Reference

Defaults come from `src/config.ts`. The Docker image also sets `NODE_ENV=production`, `PORT=3000`, and `HQ_JR_DB_PATH=/app/data/hq-jr.db`.

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `APP_ID` | Yes | none | GitHub App ID number. |
| `PRIVATE_KEY` | Yes | none | GitHub App private key, with escaped newlines. |
| `WEBHOOK_SECRET` | Yes | none | HMAC secret for webhook verification. |
| `WEBHOOK_PROXY_URL` | Optional | none | Smee channel used by Probot to receive webhooks without public ingress. |
| `GOOGLE_CLOUD_PROJECT` | Yes in practice | `test-gcp-project` | Vertex AI project. The default is a placeholder, not a working project. |
| `GOOGLE_CLOUD_LOCATION` | Optional | `global` | Vertex AI location. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional | none | Path to an ADC JSON file. Not needed on GCE with a scoped service account. |
| `HQ_JR_MODEL_TIER1` | Optional | `gemini-3.8-flash` | Triage model. |
| `HQ_JR_MODEL_TIER2` | Optional | `gemini-3.8-flash` | Deep review model. |
| `HQ_JR_AGENT_TIER3` | Optional | `antigravity-preview-05-2026` | Tier 3 sandbox agent. |
| `HQ_JR_AI_TIMEOUT_MS` | Optional | `900000` | HTTP timeout for Vertex AI requests, in milliseconds. |
| `HQ_JR_DB_PATH` | Optional | `./data/hq-jr.db` | SQLite database path. The image uses `/app/data/hq-jr.db`. |
| `PORT` | Optional | `3000` | HTTP listen port. |
| `NODE_ENV` | Optional | `development` | `development`, `production`, or `test`. Compose sets `production`. |
| `LOG_LEVEL` | Optional | `info` | `trace`, `debug`, `info`, `warn`, or `error`. |
| `HOST` | Optional | none | Bind address read by Probot. Compose sets `0.0.0.0`; the `.env` may keep `127.0.0.1`. |

## Observability

### Liveness and readiness

`GET /livez` is a process liveness probe. It returns `200` with:

```json
{
  "status": "alive",
  "uptimeSeconds": 12.05
}
```

It does not call Vertex AI. The Docker healthcheck and `deploy/update.sh` use this endpoint.

`GET /healthz` is the readiness probe. It calls `checkAiHealth` and returns JSON:

```json
{
  "status": "healthy",
  "uptimeSeconds": 12.05,
  "vertexAi": {
    "status": "ok",
    "latencyMs": 3293
  }
}
```

- `200` when the Vertex AI ping succeeds.
- `503` when it fails; `vertexAi.message` carries the provider error.

`checkAiHealth` caches its result for roughly 60 seconds, so repeated probes do not create a Vertex request each time.

### Logs

- Container logs: `docker logs hq-jr` or `docker compose logs -f`.
- Update timer logs: `sudo journalctl -u hq-jr-update.service`.
- Probot logs include the GitHub delivery context and `X-GitHub-Delivery` for webhook requests.

## Rate Limiting and Resilience

- **GitHub API limits.** Probot includes `@octokit/plugin-throttling`; secondary rate limits back off and retry.
- **Vertex AI quota limits.** `withRetry` in `src/services/ai.ts` retries `429` / `RESOURCE_EXHAUSTED` up to 3 times with exponential backoff starting at 2,500 ms.
- **SQLite durability.** Active run locks, review findings, remediation commit markers, and Tier 3 sandbox recovery all depend on a durable `HQ_JR_DB_PATH`. Use a persistent volume in every production topology.
- **Legacy source service.** The volt-rust host keeps a disabled `hq-jr.service` unit and the old `/opt/hq-jr` checkout as a fallback. New deployments should use the container path above.
