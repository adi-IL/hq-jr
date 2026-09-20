<p align="center">
  <img src="assets/logo.png" alt="Headquarter Junior logo" width="300" />
</p>

<h1 align="center">hq-jr</h1>

<p align="center">
  <strong>Headquarter Junior</strong><br />
  The tireless junior engineer stationed at Headquarters. Audits PR diffs with senior staff rigor, reproduces bugs in isolated container sandboxes, and never lets broken code slip past.
</p>

<p align="center">
  <a href="https://cloud.google.com/vertex-ai"><img src="https://img.shields.io/badge/Google%20Cloud-Vertex%20AI-4285F4?logo=googlecloud&logoColor=white" alt="Google Cloud Vertex AI" /></a>
  <a href="https://deepmind.google/technologies/gemini/"><img src="https://img.shields.io/badge/Gemini-3.8%20Flash%20High%20Thinking-8E75B2?logo=googlegemini&logoColor=white" alt="Gemini 3.8 Flash High Thinking" /></a>
  <a href="https://probot.github.io/"><img src="https://img.shields.io/badge/Probot-v13-ea4aaa?logo=probot&logoColor=white" alt="Probot v13" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22" /></a>
  <a href="https://sqlite.org/"><img src="https://img.shields.io/badge/SQLite-WAL%20State-003B57?logo=sqlite&logoColor=white" alt="SQLite WAL" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License Apache-2.0" /></a>
</p>

---

Junior sits at Headquarters, staring at incoming pull requests day and night. Human reviewers skim diffs on their phones, check if the CI green checkmark appears, and comment "LGTM". Junior does not skim.

Junior runs incoming diffs through a three-tier pipeline. First, it drops lockfiles, minified bundles, and generated code before burning a single token. Next, it runs Gemini 3.8 Flash with High Thinking to trace data flow across changed files, hunting unhandled panics, race conditions, nil dereferences, and boundary regressions. When an issue looks suspicious, Junior spins up an isolated container sandbox, writes an adversarial test case, and executes the project test suite to verify the break empirically.

If you want the fix applied, mention `@hq-jr fix`. Junior writes the patch, creates a branch, commits the fix, and opens a remediation pull request. If you are discussing architecture with a coworker, Junior stays quiet until you tag it.

### Generic AI Review Bots vs. Headquarter Junior

| Dimension | Generic AI review bots | Headquarter Junior (`hq-jr`) |
| :--- | :--- | :--- |
| **Analysis depth** | Matches surface text and suggests stylistic renames. Misses data flow across boundaries. | Audits diffs with Gemini 3.8 Flash High Thinking. Traces concurrency hazards, nil pointer dereferences, off-by-one errors, and state mutations. |
| **Empirical verification** | Guesses code behavior from prompt completions. Hallucinates package APIs and non-existent methods. | Spins up container sandboxes using the Antigravity agent. Synthesizes reproduction tests and executes build commands before reporting bugs. |
| **Noise rejection** | Reviews lockfiles, minified bundles, and documentation edits indiscriminately. Floods PRs with low-value comments. | Heuristic pre-filter drops lockfiles and vendor assets. Fast Tier 1 screening evaluates risk and bypasses trivial diffs in milliseconds. |
| **Review memory** | Stateless across commits. Nagging comments repeat after force-pushes even when code is already fixed. | SQLite WAL review memory stores audit state. Verifies whether new commits resolved previous findings and updates check runs cleanly. |
| **Line comment precision** | Uses raw diff line counts. Fails with HTTP 422 errors when lines drift during ongoing branch activity. | Validates hunk line anchors against live pull request diffs. Falls back to commit-level summaries so review comments never disappear. |
| **Thread etiquette** | Hijacks human discussions, auto-replying to developer banter and clogging notification queues. | Strict mention gating. Ignores peer-to-peer discussions completely and only speaks when addressed directly via `@hq-jr`. |
| **Code remediation** | Dumps unformatted markdown code snippets into review comments for developers to copy manually. | Synthesizes verified patches, creates a git branch, and commits clean fixes on command when authorized by write access. |
| **Credential scrubbing** | Sends raw diffs to third-party endpoints, risking exposure of accidental commit secrets. | Regex scrubbers strip modern GitHub personal access tokens, OpenAI keys, Anthropic keys, and private keys before processing. |
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
    Scrubber --> Tier1["Tier 1: Gemini 3.8 Flash Triage"]
    
    Tier1 --> TriageDecision{"Any shouldReview files?"}
    TriageDecision -->|"No"| LowRiskExit["Complete Check Run: Low Risk"]
    TriageDecision -->|"Yes"| Memory["Prior Review Memory: review-memory.ts"]
    Memory --> Tier2["Tier 2: Gemini 3.8 Flash + High Thinking Deep Review"]
    
    Tier2 --> Output["Post Line Comments (with HTTP 422 Fallback) & Complete Check Run"]
    
    Route -->|"@hq-jr fix / merge"| RBAC{"Caller write or admin?"}
    RBAC -->|"Yes"| Remediate["Autonomous Remediation: synthesizeFileFix & Branch Commit"]
    RBAC -->|"No"| Deny["Post ⛔ Access Denied Notice"]
```

### Multi-Tier AI Review Funnel

1. **Pre-AI Heuristic Filter & Diff Parser** ([`src/services/file-filter.ts`](src/services/file-filter.ts), [`src/services/diff-parser.ts`](src/services/diff-parser.ts)):
   - Excludes lockfiles, compiled artifacts (`dist/`, `build/`), vendor bundles, minified JS, and binary assets.
   - Accurately parses unified diffs including quoted file paths, Git submodules (`160000`), and file permission changes.
   - Passes all content through credential scrubber ([`src/services/scrubber.ts`](src/services/scrubber.ts)) redacting modern PATs, OpenAI/Anthropic keys, and private keys.
2. **Tier 1: Fast Triage** ([`src/services/ai.ts`](src/services/ai.ts)):
   - Rapid screening using **Gemini 3.8 Flash**.
   - Determines `risk` (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`) and `shouldReview` per file.
   - Bypasses deep review for documentation, styling, and low-risk changes, minimizing latency and quota consumption.
3. **Tier 2: Deep Semantic Audit** ([`src/services/ai.ts`](src/services/ai.ts)):
   - Deep reasoning audit powered by **Gemini 3.8 Flash with `ThinkingLevel.HIGH`**.
   - Loads prior review findings through [`src/services/review-memory.ts`](src/services/review-memory.ts) to verify whether new commits resolve previously flagged issues.
   - Identifies semantic bugs, boundary condition failures, nil dereferences, and security vulnerabilities.
   - Generates line-anchored diff comments with ````suggestion` patch blocks.
   - Includes graceful HTTP 422 fallback so comments are never lost if diff lines shift.
4. **Tier 3: Asynchronous Sandbox Verification** (CLI & Experimental Runner):
   - Autonomous reproduction agent (`antigravity-preview-05-2026`) callable via `src/cli.ts` for deep empirical test suite execution in isolated containers.

---

## Interactive GitHub Experience

- **Inline Diff Comments**: Comments and suggested code replacements appear directly on the modified lines under the **Files changed** tab.
- **GitHub Check Runs**: Real-time status reporting via `hq-jr AI Code Review` check runs.
- **Interactive PR Chat**: Mention `@hq-jr` in any PR discussion thread to ask architectural questions, explain decisions, or brainstorm solutions. Human-to-human discussions are ignored to prevent thread hijacking.
- **On-Demand Review Trigger**: Type `@hq-jr review`, `@hq-jr audit`, or `@hq-jr scan` in the PR conversation tab to rerun the full deep audit on demand.
- **Autonomous Remediation with RBAC**: Type `@hq-jr fix` or `@hq-jr patch` to synthesize clean code fixes, branch to `hq-jr/fix-pr-<id>`, and commit changes. Type `@hq-jr fix and merge` to auto-merge when permissions allow. Guarded by collaborator permission verification (`admin` or `write` access required).

---

## Quickstart

### Prerequisites

- Node.js >= 22.0.0
- Google Cloud Project with Vertex AI API enabled and Application Default Credentials (ADC) configured:
  ```bash
  gcloud auth application-default login
  gcloud config set project <PROJECT_ID>
  ```
- GitHub App registered (or registered via the 1-click Probot manifest flow).

### Installation

```bash
git clone https://github.com/adi-IL/hq-jr.git
cd hq-jr
npm install
```

### Environment Configuration

Create a `.env` file in the root directory (refer to `.env.example`):

```bash
# Probot / GitHub App Credentials
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
WEBHOOK_SECRET=your_webhook_secret
WEBHOOK_PROXY_URL=https://smee.io/your_smee_channel # Optional for local development

# Google Cloud Vertex AI
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=global

# Model Configuration
HQ_JR_MODEL_TIER1=gemini-3.8-flash
HQ_JR_MODEL_TIER2=gemini-3.8-flash
HQ_JR_AGENT_TIER3=antigravity-preview-05-2026

PORT=3000
NODE_ENV=development
```

### Running Locally

```bash
# Build TypeScript
npm run build

# Run unit tests
npm test

# Start the bot daemon
npm start

# Run in development mode with live watch
npm run dev
```

---

## Project Structure

```
hq-jr/
├── app.yml                  # GitHub App Manifest (permissions & events)
├── docs/                    # Deep-dive architecture and operations guides
│   ├── 01-architecture-and-probot.md
│   ├── 02-model-orchestration-and-vertex-adc.md
│   ├── 03-codebase-ingestion-and-context.md
│   ├── 04-github-app-lifecycle-and-security.md
│   ├── 05-deployment-and-operations.md
│   └── README.md
├── src/
│   ├── cli.ts               # Standalone PR review simulation CLI
│   ├── config.ts            # Configuration loader and environment schema
│   ├── index.ts             # Probot application entry point and event handlers
│   ├── schemas/
│   │   └── review.ts        # Zod validation schemas for AI structured outputs
│   └── services/
│       ├── ai.ts            # Vertex AI client (Gemini Tiers 1, 2, 3)
│       ├── context-packager.ts # Token budgeting and file ranking
│       ├── diff-parser.ts   # Unified diff parser and line anchor validator
│       ├── discussion.ts    # PR timeline mention answering service
│       ├── file-filter.ts   # Path evaluation and noise rejection rules
│       ├── json-repair.ts   # Resilient markdown JSON extractor
│       ├── remediation.ts   # Automated code remediation and branch commit synthesis
│       ├── review-memory.ts # Prior audit memory and multi-turn thread traversal
│       └── scrubber.ts      # Secret and token scrubber
```

---

## Documentation

Comprehensive design specifications and operational manuals are available in [`docs/`](docs/):

1. [System Architecture and Probot Framework](docs/01-architecture-and-probot.md)
2. [Model Orchestration and Vertex AI ADC](docs/02-model-orchestration-and-vertex-adc.md)
3. [Codebase Ingestion and Context Pipeline](docs/03-codebase-ingestion-and-context.md)
4. [GitHub App Lifecycle, Permissions, and Security](docs/04-github-app-lifecycle-and-security.md)
5. [Deployment and Cloud Operations](docs/05-deployment-and-operations.md)

---

## License

Apache-2.0
