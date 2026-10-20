#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { checkAiHealth, runTriage, runDeepReview, dispatchSandboxVerification, resolveDeepReviewRouting, runEscalatedDeepReview, escapeUntrustedTags } from "./services/ai.js";
import type { DeepReviewResult } from "./schemas/review.js";
import { parseUnifiedDiff, isLineInDiff } from "./services/diff-parser.js";
import { packageReviewContext } from "./services/context-packager.js";
import { config, type RiskLevel } from "./config.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "health") {
    await handleHealth();
    return;
  }

  if (command === "review") {
    await handleReview(args.slice(1));
    return;
  }

  if (command === "sandbox-test") {
    await handleSandboxTest(args.slice(1));
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`
hq-jr - Automated Code Review CLI (Powered by Vertex AI & Gemini)

This binary is the CLI only (health, review, sandbox-test).
It does not start the GitHub App webhook server. For the App daemon, clone the repo and run npm start (or use Docker).

Usage:
  hq-jr health                          Check Vertex AI ADC connectivity and latency
  hq-jr review --diff <path>            Run review on a local unified diff file
  hq-jr review --pr <number> [--repo]   Fetch PR diff using 'gh pr diff' and review
  hq-jr sandbox-test --repo <url>       Dispatch Antigravity sandbox agent test
                     --branch <name>
                     --cmd <test_cmd>
`);
}

function printModelRouting() {
  console.log("Model routing:");
  console.log(`  triage (Tier 1):      ${config.HQ_JR_MODEL_TIER1}`);
  console.log(`  escalation:           ${config.HQ_JR_MODEL_ESCALATION}`);
  console.log(`  deep review (Tier 2): ${config.HQ_JR_MODEL_TIER2}`);
  console.log(`  discussion:           ${config.HQ_JR_MODEL_DISCUSSION}`);
  console.log(`  remediation:          ${config.HQ_JR_MODEL_REMEDIATION}`);
  console.log(`  health probe:         ${config.HQ_JR_MODEL_HEALTH}`);
  console.log(`  escalation max output tokens: ${config.HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS}`);
  console.log(`  escalation threshold: ${config.HQ_JR_ESCALATION_MIN_RISK}`);
}

/**
 * Header for the deep review stage. It names the model that produced the
 * verdict, which is the Tier 2 model when the escalation model failed.
 */
export function formatDeepReviewHeader(outcome: { model: string; fellBack: boolean }): string {
  const suffix = outcome.fellBack ? " after the escalation fallback" : "";
  return `\n--- Tier 2: Deep Semantic Review (${outcome.model}${suffix}) ---`;
}

/**
 * Runs the deep review for the CLI and returns the header that names the
 * model that produced the verdict.
 */
export async function runCliDeepReview(params: {
  overallRisk: RiskLevel;
  reviewPrompt: string;
  log?: (payload: Record<string, unknown>, message: string) => void;
}): Promise<{ header: string; result: DeepReviewResult }> {
  const deepReview = await runEscalatedDeepReview({
    overallRisk: params.overallRisk,
    run: (model, role) => runDeepReview(params.reviewPrompt, { model, role }),
    log: params.log,
  });

  return { header: formatDeepReviewHeader(deepReview), result: deepReview.result };
}

async function handleHealth() {
  console.log("Checking Google Cloud Vertex AI ADC connectivity...");
  console.log(`Project:  ${config.GOOGLE_CLOUD_PROJECT}`);
  console.log(`Location: ${config.GOOGLE_CLOUD_LOCATION}`);
  printModelRouting();

  try {
    const health = await checkAiHealth();
    if (health.status === "ok") {
      console.log(`\n[SUCCESS] Vertex AI is healthy (Latency: ${health.latencyMs}ms)`);
      process.exit(0);
    } else {
      console.error(`\n[FAILURE] Vertex AI returned error: ${health.message}`);
      process.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n[FATAL] Health check failed: ${msg}`);
    process.exit(1);
  }
}

async function handleReview(args: string[]) {
  let diffContent = "";

  const diffIndex = args.indexOf("--diff");
  const prIndex = args.indexOf("--pr");
  const repoIndex = args.indexOf("--repo");

  if (diffIndex !== -1 && args[diffIndex + 1]) {
    const filePath = args[diffIndex + 1];
    console.log(`Reading diff file: ${filePath}`);
    diffContent = readFileSync(filePath, "utf-8");
  } else if (prIndex !== -1 && args[prIndex + 1]) {
    const rawPrNumber = args[prIndex + 1];
    if (!/^\d+$/.test(rawPrNumber)) {
      console.error(`Error: Invalid PR number '${rawPrNumber}'. PR number must be an integer.`);
      process.exit(1);
    }
    const ghArgs = ["pr", "diff", rawPrNumber];
    if (repoIndex !== -1 && args[repoIndex + 1]) {
      const repo = args[repoIndex + 1];
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        console.error(`Error: Invalid repository format '${repo}'. Expected format: owner/repo.`);
        process.exit(1);
      }
      ghArgs.push("--repo", repo);
    }
    console.log(`Fetching PR #${rawPrNumber} diff using GitHub CLI (gh)...`);
    try {
      diffContent = execFileSync("gh", ghArgs, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to fetch diff with gh CLI: ${msg}`);
      process.exit(1);
    }
  } else {
    console.error("Error: Either --diff <path> or --pr <number> must be specified.");
    printHelp();
    process.exit(1);
  }

  if (!diffContent || diffContent.trim().length === 0) {
    console.log("No textual diff found to review.");
    process.exit(0);
  }

  // 1. Ingestion and diff parsing
  const parsed = parseUnifiedDiff(diffContent);
  console.log(`Parsed ${parsed.files.length} modified file(s), +${parsed.totalAdditions}/-${parsed.totalDeletions} lines.`);

  // 2. Context window packager
  const context = packageReviewContext(parsed);
  console.log(`Reviewable files: ${context.itemsToReview.length}. Excluded noise files: ${context.ignoredItems.length}.`);

  if (context.itemsToReview.length === 0) {
    console.log("\nAll files were excluded by noise filters (lockfiles, assets, build artifacts). Nothing to review.");
    process.exit(0);
  }

  // 3. Tier 1 Triage
  printModelRouting();
  console.log(`\n--- Tier 1: Triage + High Thinking (${config.HQ_JR_MODEL_TIER1}) ---`);
  const triage = await runTriage(context.promptPayload);
  console.log(`Overall Risk: [${triage.overallRisk}]`);
  console.log(`Summary:      ${triage.summary}\n`);

  for (const f of triage.files) {
    console.log(`- ${f.path.padEnd(40)} [${f.risk.padEnd(6)}] (Review: ${f.shouldReview ? "YES" : "NO"}) - ${f.reason}`);
  }

  const reviewables = triage.files.filter((f) => f.shouldReview);
  if (reviewables.length === 0) {
    console.log("\nAll files classified as low risk. Deep review bypassed.");
    process.exit(0);
  }

  // 4. Tier 2 Deep Semantic Review
  const routing = resolveDeepReviewRouting(triage.overallRisk);
  console.log(
    `\nEscalation: ${routing.escalated ? "engaged" : "not engaged"} (overall risk ${triage.overallRisk}, threshold ${config.HQ_JR_ESCALATION_MIN_RISK})`
  );
  const reviewPrompt = `Local CLI Review Mode
Files requiring deep review:
${reviewables.map((f) => `- ${escapeUntrustedTags(f.path)} (Risk: ${escapeUntrustedTags(f.risk)}, Reason: ${escapeUntrustedTags(f.reason)})`).join("\n")}

${escapeUntrustedTags(context.promptPayload)}
`;

  const { header, result: review } = await runCliDeepReview({
    overallRisk: triage.overallRisk,
    reviewPrompt,
    log: (payload, message) =>
      console.warn(
        `${message}: ${payload.err instanceof Error ? payload.err.message : String(payload.err)}`
      ),
  });
  console.log(header);
  console.log(`\nVerdict: ${review.verdict}`);
  console.log(`Summary: ${review.summary}\n`);

  if (review.comments.length === 0) {
    console.log("No specific defects or vulnerabilities found. Code looks clean!");
  } else {
    console.log(`Observations (${review.comments.length}):`);
    const fileMap = new Map(parsed.files.map((f) => [f.newPath || f.oldPath, f]));

    for (const c of review.comments) {
      const matched = fileMap.get(c.path);
      const isAnchored = matched ? isLineInDiff(matched, c.line, c.side) : false;
      const anchorTag = isAnchored ? `[Anchored L${c.line}]` : `[File Note L${c.line}]`;

      console.log(`\n------------------------------------------------------------`);
      console.log(`${c.path}:${c.line} (${c.side}) ${anchorTag} [${c.severity}] [${c.category}]`);
      console.log(`Title: ${c.title}`);
      console.log(`Body:  ${c.body}`);
      if (c.suggestedPatch) {
        console.log(`\nSuggested Patch:\n${c.suggestedPatch}`);
      }
    }
  }
}

async function handleSandboxTest(args: string[]) {
  const repoIdx = args.indexOf("--repo");
  const branchIdx = args.indexOf("--branch");
  const cmdIdx = args.indexOf("--cmd");

  if (repoIdx === -1 || branchIdx === -1 || cmdIdx === -1) {
    console.error("Error: --repo, --branch, and --cmd are required for sandbox-test.");
    process.exit(1);
  }

  const repoUrl = args[repoIdx + 1];
  const branch = args[branchIdx + 1];
  const testCommand = args[cmdIdx + 1];

  console.log(`Dispatching Tier 3 Antigravity Sandbox Agent for ${repoUrl} (${branch})...`);
  const result = await dispatchSandboxVerification({
    repoUrl,
    branch,
    testCommand,
    instructions: "Run tests and verify pull request stability.",
  });

  console.log("[SUCCESS] Sandbox agent job dispatched.");
  console.log(JSON.stringify(result, null, 2));
}

/** True when this module is the process entry point, so importing it does not run the CLI. */
function isCliEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return true;
  }
}

if (isCliEntryPoint()) {
  main().catch((err) => {
    console.error("Unhandled CLI error:", err);
    process.exit(1);
  });
}
