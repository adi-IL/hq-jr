<p align="center">
  <img src="assets/logo.svg" alt="hq-jr logo" width="340" />
</p>

<h1 align="center">hq-jr</h1>

<p align="center">
  <strong>Headquarter Judge and Runner (`hq-jr`): the self-hosted pull request reviewer that can reproduce suspicious breaks in an isolated sandbox.</strong>
</p>

<p align="center">
  Self-hosted GitHub App that reviews pull requests with Vertex AI, tracks prior findings across pushes,
  and reproduces suspicious bugs in an isolated sandbox before completing the sandbox check run.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License Apache-2.0" /></a>
  <a href="https://probot.github.io/"><img src="https://img.shields.io/badge/Probot-v13-ea4aaa?logo=probot&logoColor=white" alt="Probot v13" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22.12%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22.12+" /></a>
  <a href="https://cloud.google.com/vertex-ai"><img src="https://img.shields.io/badge/Google%20Cloud-Vertex%20AI-4285F4?logo=googlecloud&logoColor=white" alt="Google Cloud Vertex AI" /></a>
  <a href="https://sqlite.org/"><img src="https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white" alt="SQLite WAL" /></a>
</p>

<p align="center">
  <img src="assets/pr-proof-preview.svg" alt="hq-jr pull request review and sandbox verification preview" width="840" />
</p>

### Why hq-jr

- **Sandbox proof.** Suspicious findings run in an isolated Antigravity container, and `hq-jr` polls for a reproduction verdict before completing the sandbox check run.
- **Mention manners.** Human discussion threads stay quiet until someone mentions `@hq-jr`, unless `hq-jr` started the thread.
- **Self-hosted on Vertex.** Review diffs are scrubbed for secrets before calling Vertex AI in your Google Cloud project. When Tier 3 runs on a same-repository pull request, the Antigravity sandbox container clones the branch to execute the reproduction test.

---

`hq-jr` filters generated noise, redacts credentials from diff text, and runs a two-step review pipeline. Tier 1 triage uses a narrow JSON schema to classify risk per file. Tier 2 runs a deep review on files that require it and escalates high-risk pull requests from `gemini-3.8-flash` to `gemini-4-argon`. Prior findings come from unresolved `hq-jr` review threads, with the latest `hq-jr` review and SQLite WAL as a fallback. When a finding requires runtime proof, Tier 3 dispatches an Antigravity container and polls for the verdict. Collaborators can comment `@hq-jr fix` to generate a remediation branch.

### Generic AI review bots vs hq-jr

| Dimension | Generic AI review bots | hq-jr |
| :--- | :--- | :--- |
| **Verification** | Guesses from static completions. | Polls the Tier 3 sandbox for a reproduction verdict before concluding the check. |
| **Memory** | Stateless across force-pushes. | Reads unresolved `hq-jr` review threads first, with SQLite WAL fallback across pushes. |
| **Noise** | Reviews lockfiles and vendor bundles. | Heuristic filter and Tier 1 triage skip low-risk diffs. |
| **Etiquette** | Replies inside human threads uninvited. | Replies only when `@hq-jr` is mentioned or when `hq-jr` started the thread. |
| **Hosting** | Sends diffs to a third-party SaaS. | Runs self-hosted against Vertex AI in your Google Cloud project. |
| **Secrets** | Sends raw diffs to model endpoints. | Scrubs common tokens and keys before model calls. |

---

## Architecture

```mermaid
flowchart TD
    PR["GitHub Webhook: PR, Comment, or Check Run"] --> Ingress["Probot Webhook Ingress: HMAC SHA-256"]
    Ingress --> Route{"Event Router"}
    
    Route -->|"PR Discussion Comment"| AntiHijack{"Is @hq-jr mentioned or hq-jr the thread root?"}
    AntiHijack -->|"Yes"| Disc["Discussion Engine: replyToDiscussion"]
    Disc --> PostReply["Post PR Thread Reply"]
    AntiHijack -->|"No"| Ignore["Ignore Human Peer Review"]
    
    Route -->|"PR Open, Sync, Reopen, @hq-jr review, or Checks re-run"| Filter["Diff Parser and Heuristic Filter"]
    Filter -->|"Zero Reviewable Hunks"| FastPass["Complete Check Run: Neutral"]
    Filter -->|"Every File Excluded by the Noise Filter"| ExcludedPass["Complete Check Run: Success"]
    Filter -->|"Reviewable Diffs"| Scrubber["Secret and Credential Scrubber"]
    Scrubber --> Tier1["Tier 1: Triage"]
    
    Tier1 --> TriageDecision{"Any shouldReview files?"}
    TriageDecision -->|"No"| LowRiskExit["Complete Check Run: Success"]
    TriageDecision -->|"Yes"| Memory["Prior Review Memory: review-memory.ts"]
    Memory --> Gate{"Triage risk >= HQ_JR_ESCALATION_MIN_RISK?"}
    Gate -->|"Yes"| Argon["Tier 2 Escalation: Gemini 4 Argon"]
    Gate -->|"No"| Tier2["Tier 2: Deep Review"]
    
    Argon --> Output["Post Line Comments and Complete Check Run"]
    Tier2 --> Output
    Output -->|"requiresSandboxVerification"| Tier3["Tier 3: Antigravity Sandbox"]
    
    Route -->|"@hq-jr fix or merge"| RBAC{"Caller has write or admin?"}
    RBAC -->|"Yes"| Remediate["Remediation: synthesizeFileFix and Branch Commit"]
    RBAC -->|"No"| Deny["Post Access Denied Notice"]
```

### Review stages

Defaults match [`src/config.ts`](src/config.ts). Tier 1 and Tier 2 default to `gemini-3.8-flash`. High-risk changes escalate Tier 2 to `gemini-4-argon`.

1. **Diff filter and parser.** [`src/services/file-filter.ts`](src/services/file-filter.ts) and [`src/services/diff-parser.ts`](src/services/diff-parser.ts) exclude lockfiles, build outputs (`dist/`, `build/`), vendor bundles, minified JavaScript, and binary assets. The parser handles quoted paths, Git submodules (`160000`), and mode changes, then passes diff text through [`src/services/scrubber.ts`](src/services/scrubber.ts).
2. **Tier 1 triage.** [`src/services/ai.ts`](src/services/ai.ts) calls `HQ_JR_MODEL_TIER1` (`gemini-3.8-flash`) with a compact prompt and schema. It assigns each file a risk level (`LOW`, `MEDIUM`, or `HIGH`) and a `shouldReview` flag, and skips deep review when no file needs it.
3. **Tier 2 deep review.** [`src/services/ai.ts`](src/services/ai.ts) calls `HQ_JR_MODEL_TIER2` (`gemini-3.8-flash`), loads prior findings from [`src/services/review-memory.ts`](src/services/review-memory.ts), and posts line-anchored comments with `CRITICAL`, `WARNING`, or `SUGGESTION` severity. If GitHub rejects a line anchor with HTTP 422, `hq-jr` appends the finding to the review summary.
4. **Tier 2 escalation.** When the triage overall risk reaches `HQ_JR_ESCALATION_MIN_RISK` (default `HIGH`), [`src/services/ai.ts`](src/services/ai.ts) routes the deep review to `HQ_JR_MODEL_ESCALATION` (`gemini-4-argon`) with an output token cap (`HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS`). If the escalation call fails, `hq-jr` logs the failure and retries once on `HQ_JR_MODEL_TIER2`.
5. **Tier 3 sandbox check.** [`src/services/sandbox-runner.ts`](src/services/sandbox-runner.ts) and [`src/cli.ts`](src/cli.ts) dispatch `HQ_JR_AGENT_TIER3` (default `antigravity-preview-05-2026`) to reproduce the issue in an isolated container. The check run stays `in_progress` while `pollSandboxInteraction` waits for the verdict. Treat Tier 3 as experimental until you validate live Antigravity in your environment.

Each workload reads its own model variable: triage (`HQ_JR_MODEL_TIER1`), deep review (`HQ_JR_MODEL_TIER2`), escalation (`HQ_JR_MODEL_ESCALATION`), discussion replies (`HQ_JR_MODEL_DISCUSSION`), remediation synthesis (`HQ_JR_MODEL_REMEDIATION`), and the health probe (`HQ_JR_MODEL_HEALTH`).

#### Review stages and spend controls

| Stage | Role | Default model or agent | When it runs | Spend control |
| :--- | :--- | :--- | :--- | :--- |
| **0. Filter and scrubber** | Drop generated files and redact secrets | Local CPU (`src/services/file-filter.ts`, `src/services/scrubber.ts`) | Pull request review runs (open, sync, reopen, `@hq-jr review`, or Checks re-run) | Spends zero tokens on ignored files and redacts secrets before any Vertex call. |
| **1. Tier 1 triage** | Classify per-file risk (`LOW`, `MEDIUM`, or `HIGH`) and `shouldReview` | `gemini-3.8-flash` (`HQ_JR_MODEL_TIER1`) | Pull requests with reviewable hunks | Uses a narrow JSON schema and exits early when no file requires deep review. |
| **2. Tier 2 deep review** | Line-anchored semantic and security review | `gemini-3.8-flash` (`HQ_JR_MODEL_TIER2`) | Triage `overallRisk` below `HQ_JR_ESCALATION_MIN_RISK`, across all `shouldReview` files | Handles pull requests below the escalation threshold on Flash. |
| **2b. Tier 2 escalation** | Escalated deep review | `gemini-4-argon` (`HQ_JR_MODEL_ESCALATION`) | Triage `overallRisk` at or above `HQ_JR_ESCALATION_MIN_RISK` (default `HIGH`) | Gated by `HQ_JR_ESCALATION_MIN_RISK` (`HIGH` by default) and capped at `HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS` (`32768`). |
| **3. Tier 3 sandbox** | Reproduction test in an isolated container | `antigravity-preview-05-2026` (`HQ_JR_AGENT_TIER3`) | `requiresSandboxVerification` or manual re-run | Runs only when a finding requires executable proof. |

---

## GitHub commands and checks

- **Inline diff comments.** Posts line comments and suggested replacements on the **Files changed** tab.
- **Check runs.** Reports status under `hq-jr AI Code Review` and `hq-jr AI Sandbox Verification`.
- **Pull request chat.** Mention `@hq-jr` to ask a question in a review thread. Human-to-human threads stay quiet.
- **On-demand review.** Comment `@hq-jr review`, `@hq-jr audit`, `@hq-jr scan`, or `@hq-jr diff` to trigger a full review.
- **Remediation with RBAC.** Comment `@hq-jr fix`, `@hq-jr patch`, or `@hq-jr remediate` (with optional `and merge`) to synthesize fixes onto branch `hq-jr/fix-pr-<id>`. Requires collaborator `admin` or `write` permission.
- **Commit reproduction test.** Click **Commit Repro Test** in the Checks tab or comment `@hq-jr commit-repro` to commit the synthesized reproduction test onto the pull request branch. Requires collaborator `admin` or `write` permission.
- **Re-run sandbox.** Click **Re-run Sandbox** in the Checks tab to re-dispatch Tier 3 with prior probes. Requires collaborator `admin` or `write` permission.

---

## Quickstart

### Prerequisites

- Node.js >= 22.12.0
- A Google Cloud project with the Vertex AI API enabled and Application Default Credentials (ADC):
  ```bash
  gcloud auth application-default login
  gcloud config set project <PROJECT_ID>
  ```
- A registered GitHub App, or one created through the Probot manifest flow.

### Installation

Install the published CLI globally:

```bash
npm i -g hq-jr
hq-jr --help
hq-jr health
```

The global install provides the CLI (`health`, `review`, `sandbox-test`). It does not start the GitHub App webhook server. To run the webhook server, clone the repository or use the Docker image below:

```bash
git clone https://github.com/adi-IL/hq-jr.git
cd hq-jr
npm install
```

### Environment variables

Create `.env` from [`.env.example`](.env.example):

```bash
# Required variables for the GitHub App and Google Cloud project
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
WEBHOOK_SECRET=your_webhook_secret
GOOGLE_CLOUD_PROJECT=your-gcp-project-id

# Optional model and runtime defaults matching src/config.ts
WEBHOOK_PROXY_URL=https://smee.io/your_smee_channel
GOOGLE_CLOUD_LOCATION=global

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

### Run locally

```bash
npm run build
npm test
npm start        # Starts the Probot webhook server
npm run dev      # Watches src/index.ts without starting the Probot server
```

### Run with Docker on Linux

Stage an ADC file that container uid 1001 can read, then run the published image:

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

The `/etc/hq-jr/gcloud` mount holds only the ADC file. On Docker Desktop, share the ADC file through the VM and mount its host path. On a Google Compute Engine VM whose service account has the Vertex AI scope, omit the mount and `GOOGLE_APPLICATION_CREDENTIALS`. The `hq-jr-data` volume preserves SQLite across container restarts.

To build and run the image from source:

```bash
docker build -t hq-jr:local .
docker run --rm -p 127.0.0.1:3000:3000 \
  --env-file .env \
  -e GOOGLE_APPLICATION_CREDENTIALS=/gcloud/application_default_credentials.json \
  -v /etc/hq-jr/gcloud:/gcloud:ro \
  -v hq-jr-data:/app/data \
  hq-jr:local
```

The container runs Probot under `tini` (PID 1) as the unprivileged `hqjr` user (uid 1001). See [docs/05-deployment-and-operations.md](docs/05-deployment-and-operations.md) for the Docker Compose setup, systemd update timer, and Cloud Run deployment.

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
