# Model Orchestration and Vertex AI ADC

## Authentication Architecture

`hq-jr` uses Google Cloud Vertex AI for model execution. Authentication runs through Application Default Credentials (ADC) without hardcoded API keys.

The bot inherits credentials directly from the host environment:
- Project ID: `your-google-cloud-project-id` (configured via `GOOGLE_CLOUD_PROJECT` or `VERTEXAI_PROJECT`).
- Credentials path: `~/.config/gcloud/application_default_credentials.json` (or GCE VM instance metadata identity).
- Default location: `global` (verified and supported for `gemini-3.8-flash` and `gemini-3.1-pro-preview` on Vertex AI).

Both local development environments and production servers use Application Default Credentials. Both Node.js (`@google/genai` >= 2.3.0) and Python (`google-genai` >= 2.3.0) resolve ADC automatically when configured with `vertexAI: { project, location }`.

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
|  |  `new GoogleGenAI({ vertexAI: { project, location } })`          |  |
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
|  |                        |  | preview            |  | preview-      |  |
|  | - Fast file triage     |  |                    |  | 05-2026       |  |
|  | - AST diff mapping     |  | - Deep logic trace |  |               |  |
|  | - Noise filtering      |  | - Security audit   |  | - Sandbox VM  |  |
|  | - Strict JSON schema   |  | - Concurrency bugs |  | - Runs tests  |  |
|  | - Synchronous          |  | - Strict patch JSON|  | - Asynchronous|  |
|  +------------------------+  +--------------------+  +---------------+  |
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
  - Map issues to exact line ranges with actionable ````suggestion` replacement diffs.
  - Author inline review comments posted directly via Octokit.

### Tier 3: Antigravity Managed Agent (`antigravity-preview-05-2026`)

- **Role.** Asynchronous test validation and adversarial reproduction (not remediation synthesis; remediation uses Flash via `synthesizeFileFix`).
- **Latency.** 30 to 300 seconds (autonomous multi-turn loop).
- **Execution Mode.** Asynchronous background execution (`background: true`) in a remote Linux sandbox container.
- **Output.** Markdown execution report and verified patch artifacts.
- **Crucial Capability Boundaries:**
  - Antigravity is a managed agent with access to bash, compilers, git, and file management.
  - It does **not** support `response_format` or structured outputs.
  - It does **not** support manual generation parameters (`temperature`, `top_p`, `max_output_tokens`).
  - Budget must be governed via `agent_config.max_total_tokens`.
- **Tasks:**
  - Mount repository source trees into `/workspace/repo`.
  - Detect and execute baseline test suites (`cargo test`, `npm test`, `pytest`).
  - Synthesize **new adversarial reproduction tests** targeting Tier 2 findings using 4 archetypes: Unit Assertions, Property-Based Tests (PBT), Subprocess Boundary Probes, and Fault-Injection Scripts.
  - Execute dual-commit trials: prove unpatched code reproduces the failure (red), apply suggested patches, and confirm the fix passes with zero regressions (green).
  - Surface an **Adversarial Test Execution Matrix** in a dedicated GitHub Check Run (`hq-jr AI Sandbox Verification`).
  - Support 1-click maintainer test adoption via the `Commit Repro Test` action button (`check_run.requested_action`).

> [!NOTE]
> In production, Tier 1 and Tier 2 execute synchronously on incoming pull request webhooks to deliver reviews within seconds. When Tier 2 detects critical boundary defects or concurrency hazards, it populates `sandboxProbes` and triggers the asynchronous Tier 3 Check Run via `src/services/sandbox-runner.ts`. After dispatch the check stays `in_progress` while `pollSandboxInteraction` polls `ai.interactions.get` (backoff, capped ~3 minutes). Conclusion mapping: `failure` when the agent hard-fails (`failed` / `budget_exceeded`) or when completed with reproduced and not cured; `success` when completed and not-reproduced or patch cured; `neutral` on incomplete, timeout, cancelled, or infra `interactions.get` failure. NOTE: On Cloud Run without a persistent volume, process death can leave checks `in_progress` until timeout/re-run; the `sandbox_jobs` row is best-effort recovery only (no durable worker queue in this PR). Tier 3 can also be tested on demand via CLI: `hq-jr sandbox-test --repo <url> --branch <name> --cmd <test_cmd>`.

## Pipeline Flow

```
GitHub Webhook Event (pull_request.opened / synchronize)
       │
       ▼
[ Tier 1: Flash + High Thinking (triage schema) ]
  ├─ Drop generated files & lockfiles
  ├─ Fast lint & syntactic boundary check
  ├─ Risk classification (Low / Medium / High)
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
  - Check Run status updated                     │             ├─ Mounts repo in Linux sandbox
                                                 │             ├─ Runs test suite & verifies fix
                                                 │             └─ Posts verified audit report
                                                 └── NO  ──► Done
```

## Structured Output Schema (Tier 1 & Tier 2)

Direct models (Tier 1 and Tier 2) enforce strict JSON schema output via `generateContent` with `responseMimeType: "application/json"` and `responseSchema`:

```json
{
  "summary": "High-level summary of review findings",
  "verdict": "APPROVE | COMMENT | REQUEST_CHANGES",
  "comments": [
    {
      "path": "src/services/auth.ts",
      "line": 42,
      "side": "RIGHT",
      "severity": "CRITICAL | WARNING | SUGGESTION",
      "category": "SECURITY | BUG | PERFORMANCE | DESIGN",
      "title": "Unvalidated redirect target allows open redirection",
      "body": "The redirect URL parameter is not checked against an allowlist.",
      "suggested_patch": "const target = isValidRedirect(url) ? url : '/dashboard';"
    }
  ]
}
```

## Implementation Snippets

### Node.js / TypeScript (`@google/genai` >= 2.3.0)

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT || "your-google-cloud-project-id",
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
  base64AuthToken: string;
}) {
  const interaction = await ai.interactions.create({
    agent: "antigravity-preview-05-2026",
    input: `Clone ${params.repoUrl}, checkout ${params.branch}, run "${params.testCommand}", and report test results and failures.`,
    agent_config: {
      type: "antigravity",
      max_total_tokens: 150000,
    },
    environment: {
      type: "remote",
      sources: [
        {
          type: "repository",
          source: params.repoUrl,
          target: "/workspace/repo",
        },
      ],
      network: {
        allowlist: [
          {
            domain: "github.com",
            transform: {
              Authorization: `Basic ${params.base64AuthToken}`,
            },
          },
        ],
      },
    },
    background: true,
  });

  return interaction.id;
}
```
