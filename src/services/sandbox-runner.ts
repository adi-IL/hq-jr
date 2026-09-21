import {
  dispatchSandboxVerification,
  pollSandboxInteraction,
  extractSandboxVerdict,
  type PollSandboxOptions,
  type PollSandboxResult,
  type SandboxVerdict,
} from "./ai.js";
import { SandboxProbeRequest } from "../schemas/review.js";
import { upsertSandboxJob, updateSandboxJobStatus } from "./db.js";

export interface SandboxCheckRunParams {
  octokit: {
    checks: {
      create: (params: {
        owner: string;
        repo: string;
        name: string;
        head_sha: string;
        status: "in_progress" | "completed";
        started_at: string;
        output: { title: string; summary: string };
        actions?: Array<{ label: string; description: string; identifier: string }>;
      }) => Promise<{ data: { id: number } }>;
      update: (params: {
        owner: string;
        repo: string;
        check_run_id: number;
        status: "in_progress" | "completed";
        conclusion?: "success" | "failure" | "neutral" | "skipped";
        completed_at?: string;
        output: { title: string; summary: string };
        actions?: Array<{ label: string; description: string; identifier: string }>;
      }) => Promise<unknown>;
    };
  };
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  branch: string;
  verificationGoal: string;
  modifiedFiles?: string[];
  testCommand?: string;
  authToken?: string;
  probes?: SandboxProbeRequest[];
  /** Injected for unit tests (short poll). */
  pollOptions?: PollSandboxOptions;
  /** Optional override of pollSandboxInteraction for tests. */
  pollFn?: (interactionId: string, options?: PollSandboxOptions) => Promise<PollSandboxResult>;
  /** Optional override of dispatchSandboxVerification for tests / manual scripts. */
  dispatchFn?: (params: Parameters<typeof dispatchSandboxVerification>[0]) => Promise<string>;
  /** Injected Database for unit tests so jobs are not written to the default on-disk DB. */
  dbInstance?: import("better-sqlite3").Database;
}

export interface SandboxCheckRunResult {
  checkRunId?: number;
  interactionId?: string;
  status: "dispatched" | "completed" | "failed" | "timed_out";
  conclusion?: "success" | "failure" | "neutral";
  summary: string;
  verdict?: SandboxVerdict | null;
}

export function detectTestCommand(filePaths: string[]): string {
  const hasCargo = filePaths.some((p) => p.includes("Cargo.toml") || /\.rs($|\b)/.test(p));
  if (hasCargo) return "cargo test";

  const hasGo = filePaths.some((p) => p.includes("go.mod") || /\.go($|\b)/.test(p));
  if (hasGo) return "go test ./...";

  const hasPython = filePaths.some(
    (p) =>
      p.includes("pytest.ini") ||
      p.includes("pyproject.toml") ||
      p.includes("requirements.txt") ||
      /\.py($|\b)/.test(p)
  );
  if (hasPython) return "pytest";

  return "npm test";
}

export function formatSandboxCheckRunSummary(params: {
  pullNumber: number;
  branch: string;
  testCommand: string;
  verificationGoal: string;
  interactionId: string;
  probes?: SandboxProbeRequest[];
  phase?: "running" | "verdict";
  verdict?: SandboxVerdict | null;
  pollStatus?: string;
}): string {
  const {
    pullNumber,
    branch,
    testCommand,
    verificationGoal,
    interactionId,
    probes = [],
    phase = "running",
    verdict,
    pollStatus,
  } = params;

  let matrixTable = "";
  if (probes.length > 0) {
    const rows = probes.map(
      (p, idx) =>
        `| #${idx + 1} | \`${p.targetFile}${p.targetLine ? `:${p.targetLine}` : ""}\` | \`${p.archetype}\` | \`${p.expectedFailureKind}\` | ${p.failureHypothesis} |`
    );
    matrixTable =
      `\n### 📊 Adversarial Test Execution Matrix\n\n` +
      `| # | Target Component | Archetype | Expected Mode | Hypothesis |\n` +
      `|:---:|---|:---:|:---:|---|\n` +
      rows.join("\n") +
      `\n`;
  }

  const statusLine =
    phase === "running"
      ? `- **Status:** Running in remote Linux container (polling interaction)\n`
      : `- **Status:** ${pollStatus || "completed"}\n`;

  let verdictSection = "";
  if (phase === "verdict" && verdict) {
    verdictSection =
      `\n### Verdict\n` +
      `- **baselinePassed:** \`${String(verdict.baselinePassed)}\`\n` +
      `- **reproduced:** \`${String(verdict.reproduced)}\`\n` +
      `- **patchCured:** \`${String(verdict.patchCured)}\`\n` +
      (verdict.summary ? `\n${verdict.summary}\n` : "");
    if (verdict.synthesizedTestCode) {
      const lang = guessFenceLang(verdict.testFilePath, testCommand);
      const pathNote = verdict.testFilePath ? ` (${verdict.testFilePath})` : "";
      verdictSection +=
        `\n### Synthesized Reproduction Test${pathNote}\n\n` +
        `\`\`\`${lang}\n${verdict.synthesizedTestCode}\n\`\`\`\n`;
    }
  }

  return (
    `## 🧪 Tier 3 Antigravity Sandbox Verification\n\n` +
    statusLine +
    `- **Agent Harness:** \`antigravity-preview-05-2026\`\n` +
    `- **Interaction ID:** \`${interactionId}\`\n` +
    `- **Target Branch:** \`${branch}\` (PR #${pullNumber})\n` +
    `- **Baseline Command:** \`${testCommand}\`\n` +
    `- **Objective:** ${verificationGoal}\n` +
    matrixTable +
    verdictSection +
    `\n### 🛠️ One-Click Test Adoption\n` +
    `Maintainers can adopt the synthesized reproduction test directly into the PR by clicking **"Commit Repro Test"** in the Checks tab action header or typing \`@hq-jr commit-repro\` in PR comments.`
  );
}

function guessFenceLang(testFilePath?: string, testCommand?: string): string {
  if (testFilePath?.endsWith(".rs") || testCommand?.includes("cargo")) return "rust";
  if (testFilePath?.endsWith(".py") || testCommand?.includes("pytest")) return "python";
  if (testFilePath?.endsWith(".go") || testCommand?.includes("go test")) return "go";
  return "typescript";
}

/**
 * Map Antigravity poll result to a GitHub check conclusion.
 *
 * Design: success when the agent finished and either the defect was not
 * reproduced (false positive / already fixed) or a suggested patch cured it.
 * Failure when the agent hard-failed or the defect reproduced and remained uncured.
 * Neutral on timeout / cancelled / unavailable.
 */
export function mapVerdictToConclusion(
  poll: PollSandboxResult
): "success" | "failure" | "neutral" {
  // Incomplete / timeout / cancelled are inconclusive signals (neutral), even if a partial verdict exists.
  if (poll.status === "timed_out" || poll.status === "cancelled" || poll.status === "incomplete") {
    return "neutral";
  }
  // Hard agent failure always fails the check, even when a verdict payload is present.
  if (poll.status === "failed") {
    return "failure";
  }

  const v = poll.verdict;
  if (!v) {
    // Completed without parseable verdict: treat as neutral (unavailable signal).
    return "neutral";
  }

  if (v.reproduced === true && v.patchCured !== true) {
    return "failure";
  }

  // not reproduced, or patch cured, or baseline-only ok without reproduction claim
  if (v.reproduced === false || v.patchCured === true || v.baselinePassed === true) {
    return "success";
  }

  return "neutral";
}

const SANDBOX_ACTIONS = [
  {
    label: "Commit Repro Test",
    description: "Commit repro test onto the PR branch",
    identifier: "commit_repro_test",
  },
  {
    label: "Re-run Sandbox",
    description: "Re-run sandbox with a fresh container",
    identifier: "rerun_sandbox",
  },
];

export async function executeSandboxCheckRun(
  params: SandboxCheckRunParams
): Promise<SandboxCheckRunResult> {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    headSha,
    branch,
    verificationGoal,
    modifiedFiles = [],
    authToken,
  } = params;

  const testCommand = params.testCommand || detectTestCommand(modifiedFiles);
  let checkRunId: number | undefined;

  try {
    const checkRun = await octokit.checks.create({
      owner,
      repo,
      name: "hq-jr AI Sandbox Verification",
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      actions: SANDBOX_ACTIONS,
      output: {
        title: "Dispatching Adversarial Sandbox Verification",
        summary: `Dispatching Tier 3 Antigravity autonomous reproduction agent for PR #${pullNumber}.\n\n- **Objective:** ${verificationGoal}\n- **Test Command:** \`${testCommand}\`\n- **Branch:** \`${branch}\`\n- **Probes:** ${params.probes?.length || 0} adversarial targets`,
      },
    });
    checkRunId = checkRun.data.id;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      summary: `Failed to create Sandbox Check Run on GitHub: ${errorMsg}`,
    };
  }

  try {
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const base64AuthToken = authToken
      ? Buffer.from(`x-access-token:${authToken}`).toString("base64")
      : undefined;

    const dispatch = params.dispatchFn ?? dispatchSandboxVerification;
    const interactionId = await dispatch({
      repoUrl,
      branch,
      testCommand,
      base64AuthToken,
      instructions: `Execute containerized reproduction and verification in /workspace/repo.\nVerification Goal: ${verificationGoal}\nRun command: ${testCommand}`,
      probes: params.probes,
    });

    const runningSummary = formatSandboxCheckRunSummary({
      pullNumber,
      branch,
      testCommand,
      verificationGoal,
      interactionId,
      probes: params.probes,
      phase: "running",
    });

    // Keep check in_progress after dispatch. Do not conclude success-on-dispatch.
    await octokit.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status: "in_progress",
      output: {
        title: "Sandbox Verification Running",
        summary: runningSummary,
      },
    });

    try {
      upsertSandboxJob(
        {
          interactionId,
          checkRunId,
          owner,
          repo,
          pullNumber,
          headSha,
          branch,
          verificationGoal,
          probesJson: params.probes ? JSON.stringify(params.probes) : null,
          testCommand,
          status: "running",
        },
        params.dbInstance
      );
    } catch {
      // Persistence is best-effort; polling still proceeds.
    }

    const pollFn = params.pollFn ?? pollSandboxInteraction;
    const pollResult = await pollFn(interactionId, params.pollOptions);

    const verdict =
      pollResult.verdict ??
      extractSandboxVerdict(pollResult.outputText) ??
      null;
    const effectivePoll: PollSandboxResult = { ...pollResult, verdict };
    const conclusion = mapVerdictToConclusion(effectivePoll);

    const verdictSummary = formatSandboxCheckRunSummary({
      pullNumber,
      branch,
      testCommand,
      verificationGoal,
      interactionId,
      probes: params.probes,
      phase: "verdict",
      verdict,
      pollStatus:
        pollResult.status === "timed_out"
          ? "Timed out waiting for agent"
          : pollResult.errorMessage
            ? `Agent status: ${pollResult.interactionStatus || pollResult.status} (${pollResult.errorMessage})`
            : `Agent status: ${pollResult.interactionStatus || pollResult.status}`,
    });

    // Do not send actions on completed check runs (GitHub returns 422).
    await octokit.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title:
          conclusion === "success"
            ? "Sandbox Verification Passed"
            : conclusion === "failure"
              ? "Sandbox Verification Failed"
              : "Sandbox Verification Inconclusive",
        summary: verdictSummary,
      },
    });

    try {
      updateSandboxJobStatus(
        interactionId,
        pollResult.status === "completed" ? conclusion : pollResult.status,
        params.dbInstance
      );
    } catch {
      // ignore
    }

    const resultStatus =
      pollResult.status === "timed_out"
        ? "timed_out"
        : pollResult.status === "failed" || pollResult.status === "cancelled"
          ? "failed"
          : "completed";

    return {
      checkRunId,
      interactionId,
      status: resultStatus,
      conclusion,
      summary: verdictSummary,
      verdict,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const failureSummary = `### Sandbox Verification Unavailable\n\nTertiary sandbox agent dispatch encountered an error: ${errorMsg}\n\nStandard Tier 1 & 2 reviews were completed.`;

    if (checkRunId) {
      try {
        await octokit.checks.update({
          owner,
          repo,
          check_run_id: checkRunId,
          status: "completed",
          conclusion: "neutral",
          completed_at: new Date().toISOString(),
          output: {
            title: "Sandbox Dispatch Skipped",
            summary: failureSummary,
          },
        });
      } catch {
        // ignore
      }
    }

    return {
      checkRunId,
      status: "failed",
      conclusion: "neutral",
      summary: failureSummary,
    };
  }
}
