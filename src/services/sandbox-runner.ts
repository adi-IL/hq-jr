import {
  dispatchSandboxVerification,
  pollSandboxInteraction,
  extractSandboxVerdict,
  type PollSandboxOptions,
  type PollSandboxResult,
  type SandboxVerdict,
} from "./ai.js";
import { SandboxProbeRequest } from "../schemas/review.js";
import {
  upsertSandboxJob,
  updateSandboxJobStatus,
  setSandboxJobInstallationId,
  claimStaleSandboxJobs,
  touchSandboxJob,
  type SandboxJobRow,
} from "./db.js";

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
  /** GitHub App installation id for crash recovery / resume. */
  installationId?: number;
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

/** Hard cap for a sandbox check summary, below GitHub's 65,535-char limit. */
export const MAX_SANDBOX_SUMMARY_CHARS = 60000;
/** Hidden marker that identifies the runner-authored synthesized test section. */
export const SYNTHESIZED_REPRO_MARKER = "<!-- hq-jr:synthesized-repro-test -->";
/** Longest single matrix cell kept when rendering untrusted probe metadata. */
const MAX_MATRIX_CELL_CHARS = 500;
/** Hard cap for the probe matrix table, including any omitted-probe notice. */
const MAX_MATRIX_CHARS = 15000;
/** Most probes rendered in the matrix table. */
const MAX_MATRIX_PROBES = 50;
/** Longest verification goal kept in the summary header. */
const MAX_VERIFICATION_GOAL_CHARS = 4000;

/** Keeps a value inside one Markdown table cell: no pipes, no line breaks, no stray backticks. */
function escapeTableCell(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/`/g, "'")
    .slice(0, MAX_MATRIX_CELL_CHARS)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

/** Removes runner-owned markers and neutralizes heading spoofs in untrusted text. */
function neutralizeSpoofedReproSection(value: string): string {
  return value
    .replace(/<!--\s*hq-jr:synthesized-repro-test\s*-->/gi, "")
    .replace(/^(\s*#{1,6}\s*)Synthesized Reproduction Test\b/gim, "$1[Synthesized Reproduction Test]");
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
    const header =
      `\n### 📊 Adversarial Test Execution Matrix\n\n` +
      `| # | Target Component | Archetype | Expected Mode | Hypothesis |\n` +
      `|:---:|---|:---:|:---:|---|\n`;
    const renderRow = (p: SandboxProbeRequest, idx: number): string => {
      const target = `${p.targetFile}${p.targetLine ? `:${p.targetLine}` : ""}`;
      return (
        `| #${idx + 1} | \`${escapeTableCell(target)}\` | \`${escapeTableCell(p.archetype)}\` | ` +
        `\`${escapeTableCell(p.expectedFailureKind)}\` | ${escapeTableCell(p.failureHypothesis)} |`
      );
    };
    const keptRows: string[] = [];
    for (let idx = 0; idx < probes.length && keptRows.length < MAX_MATRIX_PROBES; idx++) {
      const row = renderRow(probes[idx], idx);
      const nextRows = [...keptRows, row];
      const omittedAfter = probes.length - nextRows.length;
      const notice = omittedAfter > 0 ? `\n_${omittedAfter} more probes omitted._\n` : "";
      const candidateLength = header.length + nextRows.join("\n").length + 1 + notice.length;
      if (candidateLength > MAX_MATRIX_CHARS && keptRows.length > 0) break;
      keptRows.push(row);
    }
    matrixTable = header + keptRows.join("\n") + `\n`;
    const omitted = probes.length - keptRows.length;
    if (omitted > 0) {
      matrixTable += `\n_${omitted} more probes omitted._\n`;
    }
  }

  const statusLine =
    phase === "running"
      ? `- **Status:** Running in remote Linux container (polling interaction)\n`
      : `- **Status:** ${pollStatus || "completed"}\n`;

  const renderVerdictSection = (summaryText: string, testCode?: string): string => {
    if (phase !== "verdict" || !verdict) return "";
    let verdictSection =
      `\n### Verdict\n` +
      `- **baselinePassed:** \`${String(verdict.baselinePassed)}\`\n` +
      `- **reproduced:** \`${String(verdict.reproduced)}\`\n` +
      `- **patchCured:** \`${String(verdict.patchCured)}\`\n` +
      (summaryText ? `\n${summaryText}\n` : "");
    if (testCode) {
      const lang = guessFenceLang(verdict.testFilePath, testCommand);
      const pathNote = verdict.testFilePath ? ` (${verdict.testFilePath})` : "";
      verdictSection +=
        `\n${SYNTHESIZED_REPRO_MARKER}\n### Synthesized Reproduction Test${pathNote}\n\n` +
        `\`\`\`${lang}\n${testCode}\n\`\`\`\n`;
    }
    return verdictSection;
  };

  const assemble = (goal: string, summaryText: string, testCode?: string): string => {
    const footer =
      phase === "running" || testCode
        ? `\n### 🛠️ One-Click Test Adoption\n` +
          `Maintainers can adopt the synthesized reproduction test directly into the PR by clicking **"Commit Repro Test"** in the Checks tab action header or typing \`@hq-jr commit-repro\` in PR comments.`
        : "";
    return (
      `## 🧪 Tier 3 Antigravity Sandbox Verification\n\n` +
      statusLine +
      `- **Agent Harness:** \`antigravity-preview-05-2026\`\n` +
      `- **Interaction ID:** \`${interactionId}\`\n` +
      `- **Target Branch:** \`${branch}\` (PR #${pullNumber})\n` +
      `- **Baseline Command:** \`${testCommand}\`\n` +
      `- **Objective:** ${goal}\n` +
      matrixTable +
      renderVerdictSection(summaryText, testCode) +
      footer
    );
  };

  let goal = neutralizeSpoofedReproSection(verificationGoal).slice(
    0,
    MAX_VERIFICATION_GOAL_CHARS
  );
  let summaryText = neutralizeSpoofedReproSection(verdict?.summary ?? "");
  let testCode = verdict?.synthesizedTestCode || undefined;
  let output = assemble(goal, summaryText, testCode);

  if (output.length > MAX_SANDBOX_SUMMARY_CHARS && summaryText) {
    const excess = output.length - MAX_SANDBOX_SUMMARY_CHARS;
    summaryText = summaryText.slice(0, Math.max(0, summaryText.length - excess));
    output = assemble(goal, summaryText, testCode);
  }
  if (output.length > MAX_SANDBOX_SUMMARY_CHARS && goal) {
    const excess = output.length - MAX_SANDBOX_SUMMARY_CHARS;
    goal = goal.slice(0, Math.max(0, goal.length - excess));
    output = assemble(goal, summaryText, testCode);
  }
  if (output.length > MAX_SANDBOX_SUMMARY_CHARS && testCode) {
    const excess = output.length - MAX_SANDBOX_SUMMARY_CHARS;
    const remaining = testCode.length - excess;
    // Drop a fragment too short to be useful instead of slicing the fence or footer.
    testCode = remaining < 200 ? undefined : testCode.slice(0, remaining);
    output = assemble(goal, summaryText, testCode);
  }

  return output.length > MAX_SANDBOX_SUMMARY_CHARS
    ? output.slice(0, MAX_SANDBOX_SUMMARY_CHARS)
    : output;
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
  let dispatchedId: string | undefined;
  // persisted: this worker wrote the job row. reclaimed: recovery took it over.
  let persisted = false;
  let reclaimed = false;
  // Recovery owns the job and its check run now, so this worker leaves both alone.
  const reclaimedResult = (): SandboxCheckRunResult => ({
    checkRunId,
    interactionId: dispatchedId,
    status: "failed",
    summary: "Sandbox job was reclaimed by recovery; leaving the check run to it",
  });

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
    const interactionId: string = await dispatch({
      repoUrl,
      branch,
      testCommand,
      base64AuthToken,
      instructions: `Execute containerized reproduction and verification in /workspace/repo.\nVerification Goal: ${verificationGoal}\nRun command: ${testCommand}`,
      probes: params.probes,
    });

    dispatchedId = interactionId;
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
          installationId: params.installationId ?? null,
        },
        params.dbInstance
      );
      persisted = true;
    } catch {
      // Persistence is best-effort; polling still proceeds.
    }

    const pollFn = params.pollFn ?? pollSandboxInteraction;
    const basePoll = params.pollOptions ?? {};
    const baseSleep =
      basePoll.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const pollResult = await pollFn(interactionId, {
      ...basePoll,
      sleep: async (ms: number) => {
        try {
          // A false return on a persisted row means recovery claimed the job.
          if (persisted && !touchSandboxJob(interactionId, params.dbInstance)) reclaimed = true;
        } catch {
          // best-effort heartbeat for durable recovery
        }
        if (reclaimed) throw new Error("sandbox job reclaimed by recovery");
        await baseSleep(ms);
      },
    });

    if (!reclaimed && persisted) {
      try {
        reclaimed = !touchSandboxJob(interactionId, params.dbInstance);
      } catch {
        // A DB error is not proof of a reclaim; keep the verdict and close the check.
      }
    }
    if (reclaimed) return reclaimedResult();

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
    if (reclaimed) return reclaimedResult();
    const errorMsg = err instanceof Error ? err.message : String(err);
    const failureSummary = `### Sandbox Verification Unavailable\n\nTertiary sandbox agent dispatch encountered an error: ${errorMsg}\n\nStandard Tier 1 & 2 reviews were completed.`;

    let checkClosed = false;
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
        checkClosed = true;
      } catch {
        // Leave the row running so a recovery sweep can close the check later.
      }
    }
    // Mark the job finished so recovery does not re-poll a check that is already closed.
    if (persisted && dispatchedId && checkClosed) {
      try {
        updateSandboxJobStatus(dispatchedId, "failed", params.dbInstance);
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

/**
 * Finish polling an already-dispatched sandbox job and conclude its check run.
 * Used by crash recovery when the original webhook request died mid-poll.
 */
export async function completeSandboxJobPoll(params: {
  octokit: SandboxCheckRunParams["octokit"];
  job: SandboxJobRow;
  pollOptions?: PollSandboxOptions;
  pollFn?: SandboxCheckRunParams["pollFn"];
  dbInstance?: import("better-sqlite3").Database;
}): Promise<SandboxCheckRunResult> {
  const { octokit, job } = params;
  const interactionId = job.interactionId;
  const checkRunId = job.checkRunId;
  const pollFn = params.pollFn ?? pollSandboxInteraction;
  const basePoll = params.pollOptions ?? {};
  const lease = job.leaseToken ?? null;
  let leaseLost = false;
  const lostResult = (): SandboxCheckRunResult => ({
    checkRunId,
    interactionId,
    status: "failed",
    summary: "Recovery lease taken by another worker; leaving the job to it",
  });
  const baseSleep =
    basePoll.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  try {
    const pollResult = await pollFn(interactionId, {
      ...basePoll,
      sleep: async (ms: number) => {
        try {
          if (lease && !touchSandboxJob(interactionId, params.dbInstance, lease)) leaseLost = true;
        } catch {
          // ignore
        }
        // Stop polling as soon as another worker owns the job.
        if (leaseLost) throw new Error("sandbox recovery lease lost");
        await baseSleep(ms);
      },
    });

    if (leaseLost || (lease && !touchSandboxJob(interactionId, params.dbInstance, lease))) {
      return lostResult();
    }

    const verdict =
      pollResult.verdict ?? extractSandboxVerdict(pollResult.outputText) ?? null;
    const effectivePoll: PollSandboxResult = { ...pollResult, verdict };
    const conclusion = mapVerdictToConclusion(effectivePoll);

    const verdictSummary = formatSandboxCheckRunSummary({
      pullNumber: job.pullNumber,
      branch: job.branch || "unknown",
      testCommand: job.testCommand || "npm test",
      verificationGoal: job.verificationGoal || "Recovered sandbox poll",
      interactionId,
      probes: job.probesJson ? (JSON.parse(job.probesJson) as SandboxProbeRequest[]) : undefined,
      phase: "verdict",
      verdict,
      pollStatus:
        pollResult.status === "timed_out"
          ? "Timed out waiting for agent"
          : pollResult.errorMessage
            ? `Agent status: ${pollResult.interactionStatus || pollResult.status} (${pollResult.errorMessage})`
            : `Agent status: ${pollResult.interactionStatus || pollResult.status}`,
    });

    await octokit.checks.update({
      owner: job.owner,
      repo: job.repo,
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
        params.dbInstance,
        lease
      );
    } catch {
      // ignore
    }

    return {
      checkRunId,
      interactionId,
      status:
        pollResult.status === "timed_out"
          ? "timed_out"
          : pollResult.status === "failed" || pollResult.status === "cancelled"
            ? "failed"
            : "completed",
      conclusion,
      summary: verdictSummary,
      verdict,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    let leaseTaken = leaseLost;
    if (!leaseTaken && lease) {
      try {
        leaseTaken = !touchSandboxJob(interactionId, params.dbInstance, lease);
      } catch {
        // The DB is unavailable, so the lease cannot be renewed or checked.
        // Still close the check below: otherwise the caller can mark the row
        // failed (terminal) with its check run left in_progress forever.
      }
    }
    if (leaseTaken) {
      return lostResult();
    }
    let checkClosed = false;
    try {
      await octokit.checks.update({
        owner: job.owner,
        repo: job.repo,
        check_run_id: checkRunId,
        status: "completed",
        conclusion: "neutral",
        completed_at: new Date().toISOString(),
        output: {
          title: "Sandbox Verification Inconclusive",
          summary: `Recovered sandbox poll failed: ${msg}`,
        },
      });
      checkClosed = true;
    } catch {
      // Leave the job retryable so a later sweep can close the check.
    }
    try {
      updateSandboxJobStatus(interactionId, checkClosed ? "failed" : "running", params.dbInstance, lease);
    } catch {
      // ignore
    }
    return {
      checkRunId,
      interactionId,
      status: "failed",
      summary: `Recovered sandbox poll failed: ${msg}`,
    };
  }
}

/**
 * Claim stale running jobs from SQLite and finish their polls.
 * Requires a shared durable HQ_JR_DB_PATH across Cloud Run instances.
 */
export async function resumeStaleSandboxJobs(params: {
  getOctokit: (installationId: number) => Promise<SandboxCheckRunParams["octokit"] | null>;
  /** Look up the app installation for a repo. Used for legacy rows with no installation_id. */
  resolveInstallationId?: (owner: string, repo: string) => Promise<number | null>;
  pollOptions?: PollSandboxOptions;
  pollFn?: SandboxCheckRunParams["pollFn"];
  dbInstance?: import("better-sqlite3").Database;
  staleMs?: number;
  log?: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };
}): Promise<number> {
  const claimed = claimStaleSandboxJobs(params.staleMs ?? 45_000, params.dbInstance);
  let finished = 0;
  for (const job of claimed) {
    if (job.installationId == null) {
      let resolved: number | null = null;
      try {
        resolved = (await params.resolveInstallationId?.(job.owner, job.repo)) ?? null;
      } catch {
        resolved = null;
      }
      if (resolved == null) {
        // Terminal: without an installation there is no token to close the check.
        params.log?.warn(
          { interactionId: job.interactionId, owner: job.owner, repo: job.repo, checkRunId: job.checkRunId },
          "Stale sandbox job has no resolvable installation; marking orphaned"
        );
        try {
          updateSandboxJobStatus(job.interactionId, "orphaned", params.dbInstance, job.leaseToken);
        } catch {
          // ignore
        }
        continue;
      }
      try {
        setSandboxJobInstallationId(job.interactionId, resolved, params.dbInstance);
      } catch {
        // ignore; the in-memory value still lets this sweep finish the job
      }
      job.installationId = resolved;
    }
    try {
      const octokit = await params.getOctokit(job.installationId);
      if (!octokit) {
        params.log?.warn({ installationId: job.installationId }, "No octokit for sandbox recovery");
        updateSandboxJobStatus(job.interactionId, "running", params.dbInstance, job.leaseToken);
        continue;
      }
      params.log?.info(
        { interactionId: job.interactionId, checkRunId: job.checkRunId },
        "Resuming stale sandbox poll from SQLite"
      );
      await completeSandboxJobPoll({
        octokit,
        job,
        pollOptions: params.pollOptions,
        pollFn: params.pollFn,
        dbInstance: params.dbInstance,
      });
      finished += 1;
    } catch (err: unknown) {
      params.log?.warn({ err, interactionId: job.interactionId }, "Sandbox job recovery failed");
      try {
        updateSandboxJobStatus(job.interactionId, "failed", params.dbInstance, job.leaseToken);
      } catch {
        // ignore
      }
    }
  }
  return finished;
}

/**
 * Wrap an async task so overlapping calls are skipped while one is in flight.
 * Used for the periodic recovery sweep, whose polls can outlast the interval.
 */
export function singleFlight(task: () => Promise<unknown>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } finally {
      running = false;
    }
  };
}
