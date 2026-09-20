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

- **Sandbox proof.** Suspicious findings can be reproduced in an isolated container before the bot files a strong claim. Tier 3 / Antigravity is experimental.
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

It filters noise, scrubs credentials, triages with a fast model, then deep-reviews risky hunks. SQLite WAL memory tracks prior findings across pushes. When a break looks real, it can ask the experimental sandbox path to reproduce before speaking loudly. Tag `@hq-jr fix` if you want a remediation branch.

### Generic AI review bots vs hq-jr

| Dimension | Generic AI review bots | hq-jr |
| :--- | :--- | :--- |
| **Verification** | Guesses from completions. | Can reproduce in a sandbox before strong claims (Tier 3 experimental). |
| **Memory** | Stateless; repeats nags after force-push. | SQLite WAL remembers prior findings. |
| **Noise** | Reviews lockfiles and vendor junk. | Heuristic filter + Tier 1 triage skip low-risk diffs. |
| **Etiquette** | Hijacks human threads. | Speaks when `@hq-jr` is mentioned (or already in-thread). |
| **Hosting** | Third-party SaaS sees your diffs. | Self-hosted; Vertex AI in *your* GCP project. |
| **Secrets** | Raw diffs to vendor endpoints. | Scrubber redacts common tokens/keys before model calls. |

---

## Architecture Overview

```mermaid
flowchart TD
    PR["GitHub Webhook: PR / Comment / Check Run"] --> Ingress["Probot Webhook Ingress: HMAC SHA-256"]
    Ingress --> Route{"Event Router"}
    
    Route -->|"PR Discussion Comment"| AntiHijack{"Is @hq-jr mentioned or in thread history?"}
    AntiHijack -->|"Yes"| Disc["Discussion Engine: replyToDiscussion"]
    Disc --> PostReply["Post PR Thread Reply"]
    AntiHijack -->|"No"| Ignore["Ignore (Human Peer Review)"]
    
    Route -->|"PR Sync, Open, or @hq-jr review"| Filter["Diff Parser & Heuristic Filter"]
    Filter -->|"Zero Reviewable Hunks"| FastPass["Complete Check Run: Neutral"]
    Filter -->|"Reviewable Diffs"| Scrubber["Secret & Credential Scrubber"]
    Scrubber --> Tier1["Tier 1: Fast Triage"]
    
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

Defaults match [`src/config.ts`](src/config.ts): Tier 1 and Tier 2 use `gemini-3.8-flash`. Override via env if needed.

1. **Pre-AI Heuristic Filter & Diff Parser** ([`src/services/file-filter.ts`](src/services/file-filter.ts), [`src/services/diff-parser.ts`](src/services/diff-parser.ts)):
   - Excludes lockfiles, compiled artifacts (`dist/`, `build/`), vendor bundles, minified JS, and binary assets.
   - Parses unified diffs including quoted paths, Git submodules (`160000`), and permission changes.
   - Passes content through the credential scrubber ([`src/services/scrubber.ts`](src/services/scrubber.ts)).
2. **Tier 1: Fast Triage** ([`src/services/ai.ts`](src/services/ai.ts)):
   - Screening with **Gemini 3.8 Flash** (`HQ_JR_MODEL_TIER1`).
   - Sets `risk` and `shouldReview` per file; skips deep review for low-risk changes.
3. **Tier 2: Deep Semantic Audit** ([`src/services/ai.ts`](src/services/ai.ts)):
   - Deep review with **Gemini 3.8 Flash + High Thinking** (`HQ_JR_MODEL_TIER2`, same default model; optional override e.g. `gemini-3.1-pro-preview`).
   - Loads prior findings via [`src/services/review-memory.ts`](src/services/review-memory.ts).
   - Line-anchored comments with suggestion blocks; HTTP 422 fallback if lines drift.
4. **Tier 3: Sandbox Verification (experimental)** (CLI & runner):
   - Antigravity agent (`HQ_JR_AGENT_TIER3`, default `antigravity-preview-05-2026`) for empirical reproduction in isolated containers via `src/cli.ts` / [`src/services/sandbox-runner.ts`](src/services/sandbox-runner.ts).
   - Treat as experimental until you validate it in your environment.

---

## Interactive GitHub Experience

- **Inline Diff Comments**: Comments and suggested replacements on the **Files changed** tab.
- **GitHub Check Runs**: Status via `hq-jr AI Code Review`.
- **Interactive PR Chat**: Mention `@hq-jr` to ask questions. Human-to-human threads stay quiet.
- **On-Demand Review**: `@hq-jr review`, `@hq-jr audit`, or `@hq-jr scan`.
- **Remediation with RBAC**: `@hq-jr fix` / `@hq-jr patch` synthesizes a fix branch `hq-jr/fix-pr-<id>`. `@hq-jr fix and merge` when permissions allow. Requires collaborator `admin` or `write`.

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
HQ_JR_AGENT_TIER3=antigravity-preview-05-2026

PORT=3000
NODE_ENV=development
```

### Running Locally

```bash
npm run build
npm test
npm start
npm run dev   # watch mode
```

### Docker

```bash
docker build -t hq-jr:local .
docker run --rm -p 3000:3000 --env-file .env hq-jr:local
```

For Cloud Run and systemd options, see [docs/05-deployment-and-operations.md](docs/05-deployment-and-operations.md).

---

## Project Structure

```
hq-jr/
├── app.yml                  # GitHub App Manifest (permissions & events)
├── Dockerfile               # Multi-stage Node 22 production image
├── docs/                    # Architecture and operations guides
├── src/
│   ├── cli.ts               # Standalone PR / sandbox CLI
│   ├── config.ts            # Env schema (source of truth for defaults)
│   ├── index.ts             # Probot entry and event handlers
│   ├── schemas/
│   └── services/            # AI, scrubber, memory, sandbox, remediation, ...
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

## Release automation

Pushes to `master` / `main` run `.github/workflows/release.yml` when the commit message does not contain `[skip release]`:

1. Lint, test, and build
2. Bump the patch version in `package.json`
3. Publish to npm as `hq-jr`
4. Push the version commit and tag
5. Build and push `ghcr.io/adi-il/hq-jr` (version + `latest`)
6. Create a GitHub Release with the Docker image tarball attached

Required secret: `NPM_TOKEN` (Automation token on npmjs.com).

CI-only commits should include `[skip release]` in the message (the workflow adds this on its own version bumps).

## License

Apache-2.0
