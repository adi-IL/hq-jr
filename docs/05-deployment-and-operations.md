# Deployment and Operations

## Deployment Topologies

`hq-jr` can run in multiple environments depending on scale, security, and infrastructure requirements.

```
+--------------------------------------------------------------------------+
|                          Deployment Options                              |
+--------------------------------------------------------------------------+
| 1. Local Development       | 2. Google Cloud Run (Recommended)           |
|    - Node.js runtime       |    - Native GCP Vertex AI IAM integration   |
|    - Smee.io webhook proxy |    - Zero credential file management        |
|    - Host ADC credentials  |    - Auto-scales to zero when idle          |
|----------------------------+---------------------------------------------|
| 3. Standalone Container    | 4. Serverless Function (Vercel / AWS)       |
|    - Docker / Podman       |    - Event-driven cold start execution      |
|    - Systemd Linux service |    - Adapter middleware integration         |
|    - Persistent SQLite     |    - Stateless request handling             |
+--------------------------------------------------------------------------+
```


## Published container (GHCR)

Release automation publishes multi-use tags to GitHub Container Registry:

```bash
docker pull ghcr.io/adi-il/hq-jr:latest
docker pull ghcr.io/adi-il/hq-jr:0.1.2
```

The image entrypoint is `tini` with `CMD ["probot", "run", "./dist/index.js"]` (App webhook daemon). This is separate from the npm global CLI (`npm i -g hq-jr`), which only exposes `health` / `review` / `sandbox-test`.

Each successful release also attaches `hq-jr-<version>-linux-amd64.tar.gz` to the [GitHub Release](https://github.com/adi-IL/hq-jr/releases).

## Release pipeline (maintainers)

Pushes to `master` / `main` without `[skip release]` run `.github/workflows/release.yml`:

1. Test and typecheck
2. Bump patch version and build (`NODE_ENV=production`)
3. **Publish to npm**, then push the version commit and tag (so a failed publish does not leave the repo ahead of the registry)
4. Build/push GHCR image and create the GitHub Release with the Docker tarball asset

## Self-Hosted Linux VPS / Server Deployment

`hq-jr` can be hosted on any Linux server or virtual machine:

1. **Runtime.** Linux with Node.js >= 22.0.0 installed.
2. **Process Supervision.** Managed as a `systemd` service (`hq-jr.service`) or `pm2` process.
3. **ADC Authentication.** If deployed on Google Cloud Compute Engine, the VM inherits the attached service account identity. On other cloud providers or on-premises servers, authenticate via `gcloud auth application-default login` or set `GOOGLE_APPLICATION_CREDENTIALS`.

### Systemd Service Configuration Example

```ini
[Unit]
Description=hq-jr GitHub AI Code Reviewer Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/hq-jr
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5s
LimitNOFILE=65536
MemoryMax=1.5G

# Environment Configuration
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=GOOGLE_CLOUD_PROJECT=your-google-cloud-project-id
Environment=GOOGLE_CLOUD_LOCATION=global

[Install]
WantedBy=multi-user.target
```

## Alternative Topology: Google Cloud Run

Deploying on Google Cloud Run is an alternative serverless option:

1. **Native IAM Authentication.** Uses Workload Identity service account.
2. **Scalability.** Scales to zero when idle.
3. **Execution Timeout.** Cloud Run supports up to 60 minutes request timeout.

### Cloud Run Deployment Command

```bash
gcloud run deploy hq-jr \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=your-google-cloud-project-id,GOOGLE_CLOUD_LOCATION=global,LOG_LEVEL=info" \
  --set-secrets "APP_ID=HQ_JR_APP_ID:latest,PRIVATE_KEY=HQ_JR_PRIVATE_KEY:latest,WEBHOOK_SECRET=HQ_JR_WEBHOOK_SECRET:latest"
```

## Local Development Topology

During development and testing on the host machine:

1. Start a webhook tunnel via [Smee.io](https://smee.io).
2. Configure `WEBHOOK_PROXY_URL` in `.env`.
3. Probot automatically opens an EventSource connection to Smee.io, forwarding webhooks from GitHub directly to `http://localhost:3000/api/github/webhooks`.
4. Authentication to Vertex AI automatically uses the host's active ADC (`~/.config/gcloud/application_default_credentials.json`).

## Environment Variables Reference

| Variable | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `APP_ID` | Yes | GitHub App ID number. | `123456` |
| `PRIVATE_KEY` | Yes | Content of the GitHub App `.pem` private key. | `"-----BEGIN RSA PRIVATE KEY-----\n..."` |
| `WEBHOOK_SECRET` | Yes | Secret string used to verify webhook HMAC signatures. | `f83d9a102c7e8a...` |
| `WEBHOOK_PROXY_URL` | Local | Smee.io channel URL for local webhook tunneling. | `https://smee.io/AbCd1234` |
| `GOOGLE_CLOUD_PROJECT` | Yes | Google Cloud Project ID for Vertex AI. | `your-google-cloud-project-id` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Local | Path to ADC JSON credentials file. | `/home/user/.config/gcloud/...json` |
| `GOOGLE_CLOUD_LOCATION` | Optional | Vertex AI API region. Default: `global`. | `global` or `us-central1` |
| `PORT` | Optional | HTTP server listening port. Default: `3000`. | `3000` |
| `LOG_LEVEL` | Optional | Logging verbosity (`trace`, `debug`, `info`, `warn`, `error`). | `info` |

## Observability and Traceability

Every incoming webhook includes a unique GitHub delivery ID (`X-GitHub-Delivery`). Probot logs the delivery context; this app does not currently stamp a custom delivery-id field on every log line or map webhook deliveries to Vertex trace IDs.
- Prefer Cloud Logging / Probot request logs plus Check Run failure summaries when debugging.
- `checkAiHealth` records latency for a simple Vertex ping (cached ~60s).

## Rate Limiting and Resilience

- **GitHub API Limits.** Probot includes `@octokit/plugin-throttling` by default. When hitting secondary rate limits, requests automatically back off and retry.
- **Vertex AI Quota Limits.** `withRetry` in `ai.ts` retries on 429 / RESOURCE_EXHAUSTED up to **3** times with exponential backoff (initial 2500ms, doubling each attempt).
- **SQLite on Cloud Run.** Ephemeral container filesystems lose `HQ_JR_DB_PATH` data across revisions unless you mount a persistent volume (or accept in-memory / per-instance memory). Review findings, active run locks, remediation commit markers, and Tier 3 sandbox poll recovery (`resumeStaleSandboxJobs`) need durable shared storage for multi-instance or scale-to-zero topologies. Without a volume, in-flight sandbox checks can stay `in_progress` if the request dies mid-poll.
