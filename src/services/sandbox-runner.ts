import { dispatchSandboxVerification } from "./ai.js";
import { SandboxProbeRequest } from "../schemas/review.js";

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
        conclusion: "success" | "failure" | "neutral" | "skipped";
        completed_at?: string;
        output: { title: string; summary: string };
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
}

export interface SandboxCheckRunResult {
  checkRunId?: number;
  interactionId?: string;
  status: "dispatched" | "completed" | "failed";
  summary: string;
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
}): string {
  const { pullNumber, branch, testCommand, verificationGoal, interactionId, probes = [] } = params;

  let matrixTable = "";
  if (probes.length > 0) {
    const rows = probes.map(
      (p, idx) =>
        `| #${idx + 1} | \`${p.targetFile}${p.targetLine ? `:${p.targetLine}` : ""}\` | \`${p.archetype}\` | \`${p.expectedFailureKind}\` | ${p.failureHypothesis} |`
    );
    matrixTable = `\n### 📊 Adversarial Test Execution Matrix\n\n` +
      `| # | Target Component | Archetype | Expected Mode | Hypothesis |\n` +
      `|:---:|---|:---:|:---:|---|\n` +
      rows.join("\n") +
      `\n`;
  }

  return `## 🧪 Tier 3 Antigravity Sandbox Verification\n\n` +
    `- **Status:** Dispatched to remote Linux container\n` +
    `- **Agent Harness:** \`antigravity-preview-05-2026\`\n` +
    `- **Interaction ID:** \`${interactionId}\`\n` +
    `- **Target Branch:** \`${branch}\` (PR #${pullNumber})\n` +
    `- **Baseline Command:** \`${testCommand}\`\n` +
    `- **Objective:** ${verificationGoal}\n` +
    matrixTable +
    `\n### 🛠️ One-Click Test Adoption\n` +
    `Maintainers can adopt the synthesized reproduction test directly into the PR by clicking **"Commit Repro Test"** in the Checks tab action header or typing \`@hq-jr commit-repro\` in PR comments.`;
}

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
      actions: [
        {
          label: "Commit Repro Test",
          description: "Commit synthesized reproduction test directly to PR branch",
          identifier: "commit_repro_test",
        },
        {
          label: "Re-run Sandbox",
          description: "Re-run autonomous sandbox verification with fresh container",
          identifier: "rerun_sandbox",
        },
      ],
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

    const interactionId = await dispatchSandboxVerification({
      repoUrl,
      branch,
      testCommand,
      base64AuthToken,
      instructions: `Execute containerized reproduction and verification in /workspace/repo.\nVerification Goal: ${verificationGoal}\nRun command: ${testCommand}`,
      probes: params.probes,
    });

    const completionSummary = formatSandboxCheckRunSummary({
      pullNumber,
      branch,
      testCommand,
      verificationGoal,
      interactionId,
      probes: params.probes,
    });

    await octokit.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status: "completed",
      conclusion: "success",
      completed_at: new Date().toISOString(),
      output: {
        title: "Sandbox Verification Dispatched",
        summary: completionSummary,
      },
    });

    return {
      checkRunId,
      interactionId,
      status: "dispatched",
      summary: completionSummary,
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
      } catch {}
    }

    return {
      checkRunId,
      status: "failed",
      summary: failureSummary,
    };
  }
}
