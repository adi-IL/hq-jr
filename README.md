<p align="center">
  <img src="assets/logo.png" alt="Headquarter Junior logo" width="300" />
</p>

<h1 align="center">hq-jr</h1>

<p align="center">
  <strong>The junior engineer who won't say LGTM until the break reproduces.</strong>
</p>

<p align="center">
  Self-hosted GitHub App that reviews PRs with Vertex AI, remembers past findings,
  and can reproduce bugs in a sandbox before it speaks.
</p>

### Why hq-jr

- **Sandbox proof.** Suspicious findings can be dispatched to an isolated Antigravity container; hq-jr polls for a real verdict (not success-on-dispatch). Tier 3 remains experimental until validated in your environment.
- **Mention manners.** Peer-to-peer PR chat is ignored until someone addresses `@hq-jr`.
- **Self-hosted on Vertex.** Runs in your account. Diffs go to your GCP project via Vertex AI, not a third-party review SaaS.

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License Apache-2.0" /></a>
  <a href="https://probot.github.io/"><img src="https://img.shields.io/badge/Probot-v13-ea4aaa?logo=probot&logoColor=white" alt="Probot v13" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22" /></a>
  <a href="https://cloud.google.com/vertex-ai"><img src="https://img.shields.io/badge/Google%20Cloud-Vertex%20AI-4285F4?logo=googlecloud&logoColor=white" alt="Google Cloud Vertex AI" /></a>
  <a href="https://sqlite.org/"><img src="https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white" alt="SQLite WAL" /></a>
</p>

---

Junior sits on your webhook path. Humans skim diffs and type LGTM. Junior does not skim.

It filters noise, scrubs credentials from diff text, then runs a two-step Gemini Flash path: triage (narrow schema) then deep review. Both steps use High Thinking; triage is cheaper because the prompt and JSON schema are smaller. Prior findings prefer unresolved hq-jr review threads, with the latest hq-jr review and SQLite WAL as fallback when thread state is unavailable. When a break looks real, experimental Tier 3 dispatches Antigravity and polls for a reproduction verdict. Tag `@hq-jr fix` (explicit command only) if you want a remediation branch.

### Generic AI review bots vs hq-jr

| Dimension | Generic AI review bots | hq-jr |
| :--- | :--- | :--- |
| **Verification** | Guesses from completions. | Polls Tier 3 sandbox for a real verdict before concluding the check (experimental). |
| **Memory** | Stateless; repeats nags after force-push. | Unresolved hq-jr review threads first; SQLite WAL fallback across pushes. |
| **Noise** | Reviews lockfiles and vendor junk. | Heuristic filter + Tier 1 triage skip low-risk diffs. |
| **Etiquette** | Hijacks human threads. | Speaks when `@hq-jr` is mentioned (or hq-jr started the thread). |
| **Hosting** | Third-party SaaS sees your diffs. | Self-hosted; Vertex AI in *your* GCP project. |
| **Secrets** | Raw diffs to vendor endpoints. | Scrubber redacts common tokens/keys before model calls. |

---

## Architecture Overview

```mermaid
flowchart TD
    PR["GitHub Webhook: PR / Comment / Check Run"] --> Ingress["Probot Webhook Ingress: HMAC SHA-256"]
    Ingress --> Route{"Event Router"}
    
    Route -->|"PR Discussion Comment"| AntiHijack{"Is @hq-jr mentioned or hq-jr the thread root?"}
    AntiHijack -->|"Yes"| Disc["Discussion Engine: replyToDiscussion"]
    Disc --> PostReply["Post PR Thread Reply"]
    AntiHijack -->|"No"| Ignore["Ignore (Human Peer Review)"]
    
    Route -->|"PR Sync, Open, or @hq-jr review"| Filter["Diff Parser & Heuristic Filter"]
    Filter -->|"Zero Reviewable Hunks"| FastPass["Complete Check Run: Neutral"]
    Filter -->|"Reviewable Diffs"| Scrubber["Secret & Credential Scrubber"]
    Scrubber --> Tier1["Tier 1: Triage + High Thinking"]
    
    Tier1 --> TriageDecision{"Any shouldReview files?"}
    TriageDecision -->|"No"| LowRiskExit["Complete Check Run: Low Risk"]
    TriageDecision -->|"Yes"| Memory["Prior Review Memory: review-memory.ts"]
    Memory --> Tier2["Tier 2: Deep Review + High Thinking"]
    
    Tier2 --> Output["Post Line Comments (with HTTP 422 Fallback) & Complete Check Run"]
    
    Route -->|"@hq-jr fix / merge"| RBAC{"Caller write or admin?"}
    RBAC -->|"Yes"| Remediate["Autonomous Remediation: synthesizeFileFix & Branch Commit"]
    RBAC -->|"No"| Deny["Post Access Denied Notice"]
```

### Multi-Tier AI Review Funnel

Defaults match [`src/config.ts`](src/config.ts). Tier 1 and Tier 2 use `gemini-3.8-flash`. A high-risk change escalates the deep review to `gemini-4-argon`. Override any of them via env.

1. **Pre-AI Heuristic Filter & Diff Parser** ([`src/services/file-filter.ts`](src/services/file-filter.ts), [`src/services/diff-parser.ts`](src/services/diff-parser.ts)):
   - Excludes lockfiles, compiled artifacts (`dist/`, `build/`), vendor bundles, minified JS, and binary assets.
   - Parses unified diffs including quoted paths, Git submodules (`160000`), and permission changes.
   - Passes content through the credential scrubber ([`src/services/scrubber.ts`](src/services/scrubber.ts)).
2. **Tier 1: Triage** ([`src/services/ai.ts`](src/services/ai.ts)):
   - **Gemini 3.8 Flash** with **High Thinking** (`HQ_JR_MODEL_TIER1`), narrow triage prompt and schema.
   - Sets per-file **overall risk** as `LOW` | `MEDIUM` | `HIGH` and `shouldReview`; skips deep review for low-risk changes.
3. **Tier 2: Deep Semantic Audit** ([`src/services/ai.ts`](src/services/ai.ts)):
   - **Gemini 3.8 Flash** with **High Thinking** (`HQ_JR_MODEL_TIER2`; optional override e.g. `gemini-3.1-pro-preview`), wider review prompt.
   - Finding **severity** is `CRITICAL` | `WARNING` | `SUGGESTION` (separate from triage risk).
   - Loads prior findings via [`src/services/review-memory.ts`](src/services/review-memory.ts).
   - Line-anchored comments with suggestion blocks; HTTP 422 fallback if lines drift.
4. **Tier 2 Escalation: Gemini 4 Argon** ([`src/services/ai.ts`](src/services/ai.ts)):
   - When the triage **overall risk** reaches `HQ_JR_ESCALATION_MIN_RISK` (default `HIGH`), the deep review runs on `gemini-4-argon` instead (`HQ_JR_MODEL_ESCALATION`).
   - Argon costs roughly 2.7x Flash per token, so the gate keeps it off low-risk changes.
   - If the escalation call fails, the review retries once on `HQ_JR_MODEL_TIER2` and logs the fallback. A model-access or quota failure never fails the review.
   - The escalation model runs with an output token cap (`HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS`). Tier 1 and Tier 2 keep their previous uncapped behavior.
5. **Tier 3: Sandbox Verification (experimental)** (CLI & runner):
   - Antigravity agent (`HQ_JR_AGENT_TIER3`, default `antigravity-preview-05-2026`) for empirical reproduction in isolated containers via `src/cli.ts` / [`src/services/sandbox-runner.ts`](src/services/sandbox-runner.ts).
   - After dispatch the Check Run stays `in_progress` while `pollSandboxInteraction` waits for a verdict; conclusion is success/failure/neutral from that result (not success-on-dispatch).
   - Treat as experimental until you validate live Antigravity in your environment.

Each workload picks its own model, so raising one does not raise the others: triage (`HQ_JR_MODEL_TIER1`), deep review (`HQ_JR_MODEL_TIER2`), escalation (`HQ_JR_MODEL_ESCALATION`), discussion replies (`HQ_JR_MODEL_DISCUSSION`), remediation synthesis (`HQ_JR_MODEL_REMEDIATION`), and the health probe (`HQ_JR_MODEL_HEALTH`).

---

## Interactive GitHub Experience

- **Inline Diff Comments**: Comments and suggested replacements on the **Files changed** tab.
- **GitHub Check Runs**: Status via `hq-jr AI Code Review`.
- **Interactive PR Chat**: Mention `@hq-jr` to ask questions. Human-to-human threads stay quiet.
- **On-Demand Review**: `@hq-jr review`, `@hq-jr audit`, or `@hq-jr scan`.
- **Remediation with RBAC**: Explicit `@hq-jr fix` / `@hq-jr patch` / `@hq-jr remediate` (optional `and merge`) only; loose wording like "how to fix naming" does not trigger. Synthesizes branch `hq-jr/fix-pr-<id>`. Requires collaborator `admin` or `write`.
- **Commit repro test**: Check action **Commit Repro Test** or `@hq-jr commit-repro` commits the synthesized test from the sandbox check summary. Requires collaborator `admin` or `write`.
- **Re-run sandbox**: Check action **Re-run Sandbox** re-dispatches Tier 3 with prior probes when available. Requires collaborator `admin` or `write`.

---

## Quickstart

### Prerequisites

- Node.js >= 22.0.0
- Google Cloud Project with Vertex AI API enabled and Application Default Credentials (ADC):
  ```bash
  gcloud auth application-default login
  gcloud config set project <PROJECT_ID>
  ```
- GitHub App registered (or via the Probot manifest flow).

### Installation

**CLI (published package):**

```bash
npm i -g hq-jr
hq-jr --help
hq-jr health
```

The global install is the **CLI** (`health`, `review`, `sandbox-test`). It does not start the GitHub App webhook server. For the App daemon use from-source / Docker below (`npm start`).

**GitHub App / from source:**

```bash
git clone https://github.com/adi-IL/hq-jr.git
cd hq-jr
npm install
```

### Environment Configuration

Create a `.env` from [`.env.example`](.env.example):

```bash
# Probot / GitHub App Credentials
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
WEBHOOK_SECRET=your_webhook_secret
WEBHOOK_PROXY_URL=https://smee.io/your_smee_channel # Optional for local development

# Google Cloud Vertex AI
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=global

# Model Configuration (defaults match src/config.ts)
HQ_JR_MODEL_TIER1=gemini-3.8-flash
HQ_JR_MODEL_TIER2=gemini-3.8-flash
# Optional: HQ_JR_MODEL_TIER2=gemini-3.1-pro-preview
HQ_JR_MODEL_ESCALATION=gemini-4-argon
HQ_JR_ESCALATION_MIN_RISK=HIGH
HQ_JR_MODEL_DISCUSSION=gemini-3.8-flash
HQ_JR_MODEL_REMEDIATION=gemini-3.8-flash
HQ_JR_MODEL_HEALTH=gemini-3.8-flash
HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS=32768
HQ_JR_AGENT_TIER3=antigravity-preview-05-2026

PORT=3000
NODE_ENV=development
```

### Running Locally

```bash
npm run build
npm test
npm start        # Probot App daemon
npm run dev      # watches src/index.ts and its imports; does not start the Probot server
```

### Docker Quickstart (Linux)

Published image (App daemon):

On Linux, stage an ADC file readable by the container user (uid 1001):

```bash
sudo install -d -m 700 -o 1001 -g 1001 /etc/hq-jr/gcloud
sudo install -m 400 -o 1001 -g 1001 \
  "$HOME/.config/gcloud/application_default_credentials.json" \
  /etc/hq-jr/gcloud/

docker pull ghcr.io/adi-il/hq-jr:latest
# For a reproducible pin, use an image digest: ghcr.io/adi-il/hq-jr@sha256:...
docker run --rm -p 127.0.0.1:3000:3000 \
  --env-file .env \
  -e GOOGLE_APPLICATION_CREDENTIALS=/gcloud/application_default_credentials.json \
  -v /etc/hq-jr/gcloud:/gcloud:ro \
  -v hq-jr-data:/app/data \
  ghcr.io/adi-il/hq-jr:latest
```

The mount contains only the ADC file. On Docker Desktop, share the ADC file through the VM and mount its host path. On a GCE VM whose service account has the Vertex AI scope, omit the mount and `GOOGLE_APPLICATION_CREDENTIALS`. The data volume keeps SQLite across container replacement.

Build from source:

```bash
docker build -t hq-jr:local .
docker run --rm -p 127.0.0.1:3000:3000 \
  --env-file .env \
  -e GOOGLE_APPLICATION_CREDENTIALS=/gcloud/application_default_credentials.json \
  -v /etc/hq-jr/gcloud:/gcloud:ro \
  -v hq-jr-data:/app/data \
  hq-jr:local
```

Image runs Probot under `tini` (PID 1) with `probot` on `PATH`, as the unprivileged `hqjr` user (uid 1001). For the reference Compose deployment, update timer, and Cloud Run options, see [docs/05-deployment-and-operations.md](docs/05-deployment-and-operations.md).

---

## Project Structure

```
hq-jr/
├── app.yml                  # GitHub App Manifest (permissions & events)
├── deploy/                  # Reference GHCR + Compose deployment and update timer
│   ├── compose.yaml             # Container definition used by the reference host
│   ├── hq-jr-update.service     # Oneshot systemd unit that runs the updater
│   ├── hq-jr-update.timer       # Runs the update unit every 15 minutes
│   ├── refresh-deploy-files.sh  # Materializes the deploy files from the released image
│   └── update.sh                # Pulls the image, recreates on change, rolls back on failure
├── Dockerfile               # Multi-stage Node 22 production image
├── docs/                    # Architecture and operations guides
├── scripts/                 # Release, package, and documentation checks
│   ├── bump-version.mjs         # Local version bump, commit, and annotated tag
│   ├── check-doc-code-sanity.mjs  # Fails when the docs and the code disagree
│   ├── check-doc-drift.mjs        # Fails when documented env vars drift from config.ts
│   ├── check-package-contents.mjs # Fails when the npm tarball holds a forbidden file
│   └── manual-honesty-check.mjs   # End-to-end assertions on memory and sandbox paths
└── src/
    ├── cli.ts               # Standalone PR / sandbox CLI
    ├── config.ts            # Env schema (source of truth for defaults)
    ├── hq-jr-login.ts       # Exact-match check for the app's own GitHub login
    ├── index.ts             # Probot entry and event handlers
    ├── schemas/
    │   └── review.ts        # Zod contracts for the triage and deep review results
    └── services/
        ├── action-ref-verifier.ts # Drops findings that claim an existing action ref is missing
        ├── ai.ts                 # Vertex client, triage, deep review, sandbox dispatch and poll
        ├── context-packager.ts   # Ranking, char budgets, prompt payload assembly
        ├── db.ts                 # SQLite schema, migrations, run locks, findings, sandbox jobs
        ├── diff-parser.ts        # Unified diff to DiffFile / DiffHunk / DiffLine
        ├── discussion.ts         # Conversational replies in PR review threads
        ├── file-filter.ts        # Path classification, ignore rules, risk weights
        ├── json-repair.ts        # Parses and repairs malformed model JSON
        ├── remediation.ts        # Synthesizes fixes, git plumbing, push, merge
        ├── review-memory.ts      # Prior findings from threads, SQLite, and prior reviews
        ├── sandbox-runner.ts     # Tier 3 check run, polling, and the recovery sweep
        ├── scrubber.ts           # Credential redaction
        └── symbol-cache.ts       # Symbol cache helpers, not wired into the review path
```

---

## Documentation

- [Architecture and Probot](docs/01-architecture-and-probot.md)
- [Model Orchestration and Vertex AI ADC](docs/02-model-orchestration-and-vertex-adc.md)
- [Codebase Ingestion and Context](docs/03-codebase-ingestion-and-context.md)
- [GitHub App Lifecycle and Security](docs/04-github-app-lifecycle-and-security.md)
- [Deployment and Operations](docs/05-deployment-and-operations.md)
- [SECURITY.md](SECURITY.md) (threat model and vulnerability reporting)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [CHANGELOG.md](CHANGELOG.md)

---

## License

Apache-2.0
