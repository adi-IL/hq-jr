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
|  | gemini-3.8-flash       |  | gemini-4-argon     |  | antigravity-  |  |
|  |                        |  | (escalation tier)  |  | preview-      |  |
|  | - Fast file triage     |  | - High risk deep   |  | 05-2026       |  |
|  | - Noise filtering      |  |   review           |  | - Sandbox VM  |  |
|  | - Risk JSON schema     |  | - Gated on risk    |  | - Runs tests  |  |
|  | - Discussion replies   |  | - ~2.7x cost/token |  | - Async       |  |
|  | - Remediation synth    |  | - Fail soft to     |  |               |  |
|  | - Health probe         |  |   Tier 2           |  +---------------+  |
|  | - Synchronous          |  +--------------------+                     |
|  +------------------------+                                            |
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

### Escalation tier: Gemini 4 Argon (`gemini-4-argon`)

- **Role.** Runs the Tier 2 deep review on pull requests whose triage risk reaches the escalation threshold. Same prompt and same response schema as Tier 2, stronger model.
- **Gate.** `HQ_JR_ESCALATION_MIN_RISK` (default `HIGH`). The gate compares `triage.overallRisk` against the threshold with the `riskRank` total order (`LOW` < `MEDIUM` < `HIGH`), never a string comparison. Below the threshold the deep review stays on `HQ_JR_MODEL_TIER2`.
- **Availability.** Model id `gemini-4-argon`, GA since 2026-10-13, served from the `global` location that is the default `GOOGLE_CLOUD_LOCATION`. Supports structured output (`responseMimeType` plus `responseSchema`), system instructions, and thinking levels `LOW`, `MEDIUM`, `HIGH`. It rejects `thinking_budget` and `thinking_level: MINIMAL` with HTTP 400, so hq-jr only ever sends `thinkingLevel: HIGH`.
- **Limits.** Unified context window of 1,048,576 tokens, maximum 65,536 output tokens for one synchronous request.
- **Cost.** Global PayGo is 2 USD per 1M input tokens and 10 USD per 1M output tokens through 2026-11-30, then 4 in and 20 out from 2026-12-01. Gemini 3.8 Flash is 0.75 in and 3.75 out through 2026-12-31. Argon is therefore roughly **2.7x Flash per token**, which is why it is gated behind a risk threshold instead of being the default Tier 2.
- **Fail soft.** If the escalated call throws (model not enabled for the project, quota exhausted, upstream error), hq-jr retries the deep review once on `HQ_JR_MODEL_TIER2` and logs a warning. A model access or quota failure on the escalation model never fails the whole review.

### Tier 3: Antigravity Managed Agent (`antigravity-preview-05-2026`)

- **Role.** Asynchronous test validation and adversarial reproduction (not remediation synthesis; remediation uses `HQ_JR_MODEL_REMEDIATION` via `synthesizeFileFix`).
- **Latency.** The bot polls for up to 180 seconds by default. After that the attempt is reported as `timed_out` and maps to a neutral conclusion; the remote agent may continue longer server-side.
- **Execution Mode.** Asynchronous background execution (`background: true`) in a remote Linux sandbox container.
- **Output.** Structured reproduction verdict JSON (`/workspace/reproduction-verdict.json`) plus an execution report.
- **Crucial Capability Boundaries:**
  - Antigravity is a managed agent with access to bash, compilers, git, and file management.
  - It does **not** support `response_format` or structured outputs.
  - It does **not** support manual generation parameters (`temperature`, `top_p`, `max_output_tokens`).
  - Budget must be governed via `agent_config.max_total_tokens`.
- **Tasks:**
  - Clone the target repository into `/workspace/repo` (the dispatch sends no source bundle, and the environment is `remote` with a github.com allowlist when an installation token is available).
  - Detect and execute baseline test suites (`cargo test`, `go test ./...`, `pytest`, `npm test`).
  - Synthesize **new adversarial reproduction tests** targeting Tier 2 findings using 4 archetypes: Unit Assertions, Property-Based Tests (PBT), Subprocess Boundary Probes, and Fault-Injection Scripts.
  - Execute dual-commit trials: prove unpatched code reproduces the failure (red), apply suggested patches, and confirm the fix passes with zero regressions (green).
  - Surface an **Adversarial Test Execution Matrix** in a dedicated GitHub Check Run (`hq-jr AI Sandbox Verification`).
  - Support 1-click maintainer test adoption via the `Commit Repro Test` action button (`check_run.requested_action`).

> [!NOTE]
> In production, Tier 1 and Tier 2 execute synchronously on incoming pull request webhooks and post results when the run completes. When the deep review sets `requiresSandboxVerification`, it populates `sandboxProbes` and hq-jr triggers the asynchronous Tier 3 Check Run via `src/services/sandbox-runner.ts`. After dispatch the check stays `in_progress` while `pollSandboxInteraction` polls `ai.interactions.get` (backoff, capped ~3 minutes). Conclusion mapping: `failure` when the agent hard-fails (`failed` / `budget_exceeded`) or when completed with reproduced and not cured; `success` when completed and not-reproduced or patch cured; `neutral` on incomplete, timeout, cancelled, or infra `interactions.get` failure. NOTE: On Cloud Run without a persistent volume, process death can leave checks `in_progress` until timeout/re-run; with a shared durable `HQ_JR_DB_PATH`, `resumeStaleSandboxJobs` claims jobs whose heartbeat is older than 45 seconds and finishes the poll. Each claim writes a `lease_token`. Heartbeats, status writes and check-run closes only land while that token still matches, and the original worker stops once recovery holds the job, so two workers never conclude the same check. Tier 3 can also be tested on demand via CLI: `hq-jr sandbox-test --repo <url> --branch <name> --cmd <test_cmd>`.

### Model routing and configuration

`HQ_JR_MODEL_TIER1` used to drive triage, discussion replies, remediation synthesis, and the health probe at once, so raising it for better triage silently raised remediation cost. Each caller now has its own variable.

| Variable | Default | Used by |
| --- | --- | --- |
| `HQ_JR_MODEL_TIER1` | `gemini-3.8-flash` | Tier 1 triage only. |
| `HQ_JR_MODEL_TIER2` | `gemini-3.8-flash` | Tier 2 deep review below the escalation threshold. |
| `HQ_JR_MODEL_ESCALATION` | `gemini-4-argon` | Tier 2 deep review at or above `HQ_JR_ESCALATION_MIN_RISK`. |
| `HQ_JR_ESCALATION_MIN_RISK` | `HIGH` | Risk threshold that engages the escalation model (`LOW` \| `MEDIUM` \| `HIGH`). |
| `HQ_JR_MODEL_DISCUSSION` | `gemini-3.8-flash` | Replies in review discussion threads. |
| `HQ_JR_MODEL_REMEDIATION` | `gemini-3.8-flash` | Autonomous remediation synthesis. |
| `HQ_JR_MODEL_HEALTH` | `gemini-3.8-flash` | Health probe (`/healthz`, `hq-jr health`). |
| `HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS` | `32768` | Output token cap sent on a call that runs on `HQ_JR_MODEL_ESCALATION`. |

- **Output cap.** `HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS` is sent as `maxOutputTokens` on the escalation model call only. Argon bills a completion once it crosses 32K output tokens, and a billed completion survives a later failure of the request, so the cap is what keeps a runaway deep review from being charged twice. The cap is keyed on the escalation model id, so it applies to whichever deep review call runs on `HQ_JR_MODEL_ESCALATION`. Triage, the discussion replies, the remediation synthesis and the health probe never send a cap, and the Tier 2 deep review stays uncapped while it runs on `HQ_JR_MODEL_TIER2`.
- **Visibility.** `hq-jr health` and `hq-jr review` print the resolved model for every tier, so a local run shows which model actually served each stage. The app logs the resolved deep review model when a review starts.
- **Compatibility.** `HQ_JR_MODEL_TIER1` and `HQ_JR_MODEL_TIER2` keep their names and defaults, but `HQ_JR_MODEL_TIER1` no longer drives the discussion, remediation and health calls. A deployment that set `HQ_JR_MODEL_TIER1` to anything other than `gemini-3.8-flash` sees those three call sites move to `gemini-3.8-flash` after this change. To keep the previous behavior, set `HQ_JR_MODEL_DISCUSSION`, `HQ_JR_MODEL_REMEDIATION` and `HQ_JR_MODEL_HEALTH` to the same value that `HQ_JR_MODEL_TIER1` used to hold. `HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS` is new in this release and caps the escalation model only, so no existing call gains a cap.

## Pipeline Flow

```
GitHub Webhook Event (pull_request.opened / synchronize)
       │
       ▼
[ Heuristic filter: drop generated files & lockfiles ]
       │
       ▼
[ Tier 1: Flash + High Thinking (triage schema) ]
  ├─ Model-based risk classification (Low / Medium / High)
  └─ Output: Strict JSON triage report
       │
        ├── All Low Risk ──► [ Complete Check Run: Success ]
        │
        ▼ High / Medium Risk Chunks
[ Escalation gate: overallRisk >= HQ_JR_ESCALATION_MIN_RISK (default HIGH)? ]
  ├─ Yes ──► [ Tier 2 on Argon (gemini-4-argon) ]
  │             └─ on failure ──► retry once on Tier 2 (Flash) and log a warning
  └─ No  ──► [ Tier 2: Flash + High Thinking (deep review schema) ]
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

The TypeScript definitions live in `src/schemas/review.ts`; `line` defaults to `1`, `side` defaults to `RIGHT`, `requiresSandboxVerification` defaults to `false`, and `resolvedPriorIssues`, `unresolvedPriorIssues`, and `sandboxProbes` default to empty. `comments` is required.

The JSON `responseSchema` sent to the model lives in `src/services/ai.ts` (`TRIAGE_RESPONSE_SCHEMA`, `DEEP_REVIEW_RESPONSE_SCHEMA`). Both declarations describe the same contract. A field is required in the model contract when the Zod schema always produces it: plain fields and fields with a Zod default (`line`, `side`, `requiresSandboxVerification`, `resolvedPriorIssues`, `unresolvedPriorIssues`, `sandboxProbes`) are required, and only `ZodOptional` fields (`verificationGoal`, `suggestedPatch`, `targetLine`) are not. Requiring `line` and `side` keeps the model from emitting a review comment without a diff anchor. A parity test in `src/services/ai.test.ts` compares field names, field types, enum members, and required sets on both sides, so a change to one declaration without the other fails the suite.

Untrusted input is wrapped in `<untrusted_diff>` for triage and in `<untrusted_context>` for the deep review. `escapeUntrustedTags` in `src/services/ai.ts` neutralizes those tag names, plus `untrusted_pr_metadata`, in every untrusted field: the triage diff, the PR metadata block, the reviewed file list and reasons, the deep review prompt payload, and the discussion diff hunk, thread history and developer query. Discussion replies also neutralize `developer_query`, the tag that wraps the query. It inserts a backslash after the `<` and leaves everything else in place, including whitespace or line breaks before the tag name, attributes, the closing angle bracket and the rest of the payload. A pull request therefore cannot close a wrapper and push the rest of the payload outside the untrusted region.

## Implementation Snippets

### Node.js / TypeScript (`@google/genai` >= 2.3.0)

```typescript
import { GoogleGenAI } from "@google/genai";
import { config } from "./config.js";
import { resolveDeepReviewModel } from "./services/ai.js";

const ai = new GoogleGenAI({
  vertexai: true,
  project: config.GOOGLE_CLOUD_PROJECT,
  location: config.GOOGLE_CLOUD_LOCATION,
});

export async function runTriage(diffText: string) {
  const res = await ai.models.generateContent({
    model: config.HQ_JR_MODEL_TIER1,
    contents: diffText,
    config: {
      responseMimeType: "application/json",
      responseSchema: { /* triage schema */ },
    },
  });
  return res.text;
}

export async function runDeepReview(contextPrompt: string, options?: { model?: string }) {
  const res = await ai.models.generateContent({
    model: options?.model ?? config.HQ_JR_MODEL_TIER2,
    contents: contextPrompt,
    config: {
      responseMimeType: "application/json",
      // Only the escalation model is capped.
      ...(options?.model === config.HQ_JR_MODEL_ESCALATION
        ? { maxOutputTokens: config.HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS }
        : {}),
      responseSchema: { /* deep review schema */ },
    },
  });
  return res.text;
}

// Escalation gate, applied before the deep review.
const deepModel = resolveDeepReviewModel(triage.overallRisk);

export async function dispatchSandboxVerification(params: {
  repoUrl: string;
  branch: string;
  testCommand: string;
  instructions: string;
}) {
  const interaction = await ai.interactions.create({
    agent: config.HQ_JR_AGENT_TIER3,
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
    // "remote" on its own when there is no installation token. With a token the
    // environment carries a network allowlist that restricts the sandbox to
    // github.com and injects the token as a Basic authorization header.
    environment: base64AuthToken
      ? {
          type: "remote",
          network: {
            allowlist: [
              {
                domain: "github.com",
                transform: { Authorization: `Basic ${base64AuthToken}` },
              },
            ],
          },
        }
      : "remote",
    background: true,
  });

  return interaction.id;
}
```

The real implementation in `src/services/ai.ts` also injects probe instructions and the full verdict contract. It does not attach a source bundle, so the agent clones the repository itself. When an installation token is available it does attach a network allowlist that restricts the sandbox to `github.com` and injects the token as a `Basic` authorization header, so a private repository can be cloned. Without a token the request carries no allowlist and no credentials. `pollSandboxInteraction` then polls the interaction with backoff and a 180-second default cap.
