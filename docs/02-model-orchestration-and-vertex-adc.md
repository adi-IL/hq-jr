# Model Orchestration and Vertex AI ADC

## Authentication Architecture

`hq-jr` uses Google Cloud Vertex AI for model execution. Authentication runs through Application Default Credentials (ADC) without hardcoded API keys.

The bot reads configuration from the host environment:
- Project ID: `GOOGLE_CLOUD_PROJECT`. The schema default is the placeholder `test-gcp-project`; set a real project in production.
- Credentials: ADC via `GOOGLE_APPLICATION_CREDENTIALS`, `~/.config/gcloud/application_default_credentials.json`, or the GCE metadata server when the attached service account has the Vertex AI scope.
- Default location: `global`.

Local development and production both use Application Default Credentials. This repository ships only the Node.js client (`@google/genai` >= 2.3.0). It does not include a Python client.

```
+-------------------------------------------------------------------------+
|                    Host Machine / Production Server                       |
|                                                                         |
|  Environment / Instance Metadata:                                       |
|  - GOOGLE_CLOUD_PROJECT="your-google-cloud-project-id"                    |
|  - GOOGLE_CLOUD_LOCATION="global"                                       |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  |                     Google GenAI Client                           |  |
|  |  `new GoogleGenAI({ vertexai: true, project, location })`       |  |
|  +---------------------------------+---------------------------------+  |
+------------------------------------+------------------------------------+
                                     |
                                     | OAuth2 Bearer Token Exchange (ADC)
                                     v
+-------------------------------------------------------------------------+
|                        Google Cloud Vertex AI                           |
|                                                                         |
|  +------------------------+  +--------------------+  +---------------+  |
|  | gemini-3.8-flash       |  | gemini-3.1-pro-    |  | antigravity-  |  |
|  |                        |  | preview (optional) |  | preview-      |  |
|  |                        |  |                    |  | 05-2026       |  |
|  | - Fast file triage     |  | - Deep logic trace |  | - Sandbox VM  |  |
|  | - Noise filtering      |  | - Security audit   |  | - Runs tests  |  |
|  | - Risk JSON schema     |  | - Concurrency bugs |  | - Async       |  |
|  | - Synchronous          |  | - Line anchoring   |  |               |  |
|  +------------------------+  | - Strict patch JSON|  +---------------+  |
|                              +--------------------+                     |
+-------------------------------------------------------------------------+
```

## Model and Agent Tier Responsibilities

The system splits operational responsibilities according to capabilities: direct models handle synchronous line-by-line review comments with schema enforcement, while managed agents handle asynchronous test execution in sandboxed environments.

### Tier 1: Gemini 3.8 Flash triage (`gemini-3.8-flash`)

- **Role.** Narrow triage: which files need deep review, and overall risk per file.
- **Thinking.** Uses `thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH }` like Tier 2. Cost and latency stay lower because the triage prompt and JSON schema are smaller.
- **Execution Mode.** Synchronous direct model inference via Vertex / `@google/genai`.
- **Output.** Structured JSON triage schema.
- **Risk field.** Per-file and overall risk: `LOW` | `MEDIUM` | `HIGH` (not finding severity).
- **Tasks:**
  - Ingest packaged diffs / context from the review pipeline.
  - Mark auto-generated, lockfile, and trivial paths as `shouldReview: false` with risk `LOW` when appropriate.
  - Produce initial risk scores (`LOW`, `MEDIUM`, `HIGH`) for each file.
  - Terminate early with a passing Check Run if nothing needs deep review.

### Tier 2: Gemini 3.8 Flash deep review (`gemini-3.8-flash`)

- **Role.** Deep semantic review, security audit, prior-finding verification, and invariant analysis. Configurable to `gemini-3.1-pro-preview` via `HQ_JR_MODEL_TIER2`.
- **Thinking.** Synchronous reasoning with `thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH }`.
- **Finding severity.** Each finding uses `CRITICAL` | `WARNING` | `SUGGESTION`. Do not confuse this with Tier 1 overall risk.
- **Context Window.** Up to 1,000,000 tokens.
- **Output.** Strict JSON Schema conforming to GitHub review comment specifications.
- **Tasks:**
  - Ingest prior review context (`review-memory.ts`) to verify if new commits resolved past bugs.
  - Verify boundary conditions, nil-safety, and exception handling paths.
  - Trace state changes across callers and callee chains.
  - Identify race conditions, concurrency hazards, and memory leaks.
  - Map each issue to a single diff line and side, with an optional `suggestedPatch` replacement snippet.
  - Author inline review comments posted directly via Octokit.

### Tier 3: Antigravity Managed Agent (`antigravity-preview-05-2026`)

- **Role.** Asynchronous test validation and adversarial reproduction (not remediation synthesis; remediation uses Flash via `synthesizeFileFix`).
- **Latency.** The bot polls for up to 180 seconds by default. After that the attempt is reported as `timed_out` and maps to a neutral conclusion; the remote agent may continue longer server-side.
- **Execution Mode.** Asynchronous background execution (`background: true`) in a remote Linux sandbox container.
- **Output.** Structured reproduction verdict JSON (`/workspace/reproduction-verdict.json`) plus an execution report.
- **Crucial Capability Boundaries:**
  - Antigravity is a managed agent with access to bash, compilers, git, and file management.
  - It does **not** support `response_format` or structured outputs.
  - It does **not** support manual generation parameters (`temperature`, `top_p`, `max_output_tokens`).
  - Budget must be governed via `agent_config.max_total_tokens`.
- **Tasks:**
  - Clone the target repository into `/workspace/repo` (the dispatch uses `environment: "remote"` and sends no source bundle).
  - Detect and execute baseline test suites (`cargo test`, `npm test`, `pytest`).
  - Synthesize **new adversarial reproduction tests** targeting Tier 2 findings using 4 archetypes: Unit Assertions, Property-Based Tests (PBT), Subprocess Boundary Probes, and Fault-Injection Scripts.
  - Execute dual-commit trials: prove unpatched code reproduces the failure (red), apply suggested patches, and confirm the fix passes with zero regressions (green).
  - Surface an **Adversarial Test Execution Matrix** in a dedicated GitHub Check Run (`hq-jr AI Sandbox Verification`).
  - Support 1-click maintainer test adoption via the `Commit Repro Test` action button (`check_run.requested_action`).

> [!NOTE]
> In production, Tier 1 and Tier 2 execute synchronously on incoming pull request webhooks and post results when the run completes. When Tier 2 detects critical boundary defects or concurrency hazards, it populates `sandboxProbes` and triggers the asynchronous Tier 3 Check Run via `src/services/sandbox-runner.ts`. After dispatch the check stays `in_progress` while `pollSandboxInteraction` polls `ai.interactions.get` (backoff, capped ~3 minutes). Conclusion mapping: `failure` when the agent hard-fails (`failed` / `budget_exceeded`) or when completed with reproduced and not cured; `success` when completed and not-reproduced or patch cured; `neutral` on incomplete, timeout, cancelled, or infra `interactions.get` failure. NOTE: On Cloud Run without a persistent volume, process death can leave checks `in_progress` until timeout/re-run; with a shared durable `HQ_JR_DB_PATH`, `resumeStaleSandboxJobs` claims jobs whose heartbeat is older than 45 seconds and finishes the poll. Each claim writes a `lease_token`. Heartbeats, status writes and check-run closes only land while that token still matches, and the original worker stops once recovery holds the job, so two workers never conclude the same check. Tier 3 can also be tested on demand via CLI: `hq-jr sandbox-test --repo <url> --branch <name> --cmd <test_cmd>`.

## Pipeline Flow

```
GitHub Webhook Event (pull_request.opened / synchronize)
       │
       ▼
[ Tier 1: Flash + High Thinking (triage schema) ]
  ├─ Drop generated files & lockfiles in the heuristic filter
  ├─ Model-based risk classification (Low / Medium / High)
  └─ Output: Strict JSON triage report
       │
        ├── All Low Risk ──► [ Complete Check Run: Success ]
        │
        ▼ High / Medium Risk Chunks
[ Tier 2: Flash + High Thinking (deep review schema) ]
  ├─ Deep semantic trace on modified call sites
  ├─ Audit verification against prior review memory
  ├─ Security vulnerability & concurrency audit
  ├─ Line-anchored patch generation
  └─ Output: Strict JSON review comments
       │
       ├─────────────────────────────────────────┐
       ▼                                         ▼
[ GitHub Inline Review Comments ]     ( Critical bug or verification needed? )
  - Posts via Octokit REST                       ├── YES ──► [ Tier 3: antigravity-preview-05-2026 ]
  - Direct PR line annotations                   │             ├─ Dispatches background job
  - Check Run status updated                     │             ├─ Clones repo in Linux sandbox
                                                 │             ├─ Runs test suite & verifies fix
                                                 │             └─ Posts verified audit report
                                                 └── NO  ──► Done
```

## Structured Output Schemas

Both direct tiers use `generateContent` with `responseMimeType: "application/json"` and `responseSchema`. They do not share one schema.

### Tier 1: triage

```json
{
  "summary": "High-level triage summary",
  "overallRisk": "LOW | MEDIUM | HIGH",
  "files": [
    {
      "path": "src/services/auth.ts",
      "risk": "LOW | MEDIUM | HIGH",
      "reason": "Why this file received this risk",
      "shouldReview": true
    }
  ]
}
```

### Tier 2: deep review

```json
{
  "summary": "Detailed semantic review summary",
  "verdict": "APPROVE | COMMENT | REQUEST_CHANGES",
  "resolvedPriorIssues": ["Prior issue verified as fixed"],
  "unresolvedPriorIssues": ["Prior issue still open"],
  "comments": [
    {
      "path": "src/services/auth.ts",
      "line": 42,
      "side": "RIGHT",
      "severity": "CRITICAL | WARNING | SUGGESTION",
      "category": "SECURITY | BUG | PERFORMANCE | DESIGN | STYLE",
      "title": "Unvalidated redirect target allows open redirection",
      "body": "The redirect URL parameter is not checked against an allowlist.",
      "suggestedPatch": "const target = isValidRedirect(url) ? url : '/dashboard';"
    }
  ],
  "requiresSandboxVerification": false,
  "verificationGoal": "Optional objective for Tier 3",
  "sandboxProbes": [
    {
      "targetFile": "src/services/auth.ts",
      "targetLine": 42,
      "archetype": "UNIT_ASSERTION | PROPERTY_BASED | SUBPROCESS_PROBE | FAULT_INJECTION",
      "failureHypothesis": "Boundary condition that triggers the defect",
      "expectedFailureKind": "PANIC | EXCEPTION | RESOURCE_LEAK | WRONG_OUTPUT | CRASH",
      "suggestedPatch": "Optional remediation snippet"
    }
  ]
}
```

The TypeScript definitions live in `src/schemas/review.ts`; `line` defaults to `1`, `side` defaults to `RIGHT`, and `resolvedPriorIssues`, `unresolvedPriorIssues`, and `sandboxProbes` default to empty. `comments` is required.

## Implementation Snippets

### Node.js / TypeScript (`@google/genai` >= 2.3.0)

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT || "test-gcp-project",
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
});

export async function runTriage(diffText: string) {
  const res = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: diffText,
    config: {
      responseMimeType: "application/json",
      responseSchema: { /* triage schema */ },
    },
  });
  return res.text;
}

export async function runDeepReview(contextPrompt: string) {
  const res = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: contextPrompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: { /* deep review schema */ },
    },
  });
  return res.text;
}

export async function dispatchSandboxVerification(params: {
  repoUrl: string;
  branch: string;
  testCommand: string;
  instructions: string;
}) {
  const interaction = await ai.interactions.create({
    agent: "antigravity-preview-05-2026",
    input: `You are the Tier 3 verification agent.
Clone ${params.repoUrl} on branch ${params.branch} into /workspace/repo,
run "${params.testCommand}", and write the verdict to
/workspace/reproduction-verdict.json.

Verification goal:
${params.instructions}`,
    agent_config: {
      type: "antigravity",
      max_total_tokens: "150000",
    },
    environment: "remote",
    background: true,
  });

  return interaction.id;
}
```

The real implementation in `src/services/ai.ts` also injects probe instructions and the full verdict contract. It does not attach a source bundle or a network allowlist; the agent clones the repository itself. `pollSandboxInteraction` then polls the interaction with backoff and a 180-second default cap.
