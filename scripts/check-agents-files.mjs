#!/usr/bin/env node
/**
 * Fails when the agent instructions drift out of the shape CI can check.
 *
 * AGENTS.md is short on purpose. A pasted env table or a secret goes stale
 * or leaks, and a link to a file that was renamed sends the next agent to
 * nothing. This reads the file and the paths it names. It does not read
 * .env, and a secret match is reported by pattern name only.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LINE_BUDGET = 120;

const SKILL_LINKS = [
  ".agents/skills/daily-maintenance/SKILL.md",
  ".agents/skills/release-guard/SKILL.md",
  ".agents/skills/review-loop/SKILL.md",
];

const SECRET_PATTERNS = [
  { name: "AKIA", pattern: /AKIA/ },
  { name: "ghp_", pattern: /ghp_/ },
  { name: "github_pat_", pattern: /github_pat_/ },
  { name: "BEGIN PRIVATE KEY", pattern: /BEGIN PRIVATE KEY/ },
];

/** Lines the way `wc -l` counts a file that ends in a newline. */
export function lineCount(text) {
  if (text.length === 0) return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.length === 0) return 0;
  return body.split("\n").length;
}

/**
 * Repo-relative paths written in backticks. A token with no slash is a name,
 * not a path, so `package.json` is left to the reader. Commands and URLs
 * are not paths.
 */
export function backtickPaths(text) {
  const found = [];
  const re = /`([^`\n]+)`/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const token = match[1].trim();
    if (!token.includes("/")) continue;
    if (token.startsWith("/") || token.includes("://") || /\s/.test(token)) continue;
    if (!/^[A-Za-z0-9._/-]+$/.test(token)) continue;
    found.push(token);
  }
  return found;
}

/**
 * @param {string} root directory that holds AGENTS.md
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkAgentsFiles(root) {
  const problems = [];
  const agentsPath = join(root, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    return { ok: false, problems: ["AGENTS.md is missing"] };
  }

  const text = readFileSync(agentsPath, "utf8");

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      problems.push(`AGENTS.md matches secret pattern ${name}`);
    }
  }

  const lines = lineCount(text);
  if (lines > LINE_BUDGET) {
    problems.push(`AGENTS.md is ${lines} lines. The budget is ${LINE_BUDGET}.`);
  }

  for (const link of SKILL_LINKS) {
    if (!text.includes(link)) {
      problems.push(`AGENTS.md does not link ${link}`);
    }
  }

  for (const rel of backtickPaths(text)) {
    if (!existsSync(join(root, rel))) {
      problems.push(`AGENTS.md links ${rel}, which does not exist`);
    }
  }

  return { ok: problems.length === 0, problems };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = checkAgentsFiles(root);
  if (!result.ok) {
    for (const problem of result.problems) console.error(problem);
    process.exit(1);
  }
  console.log("agent instruction files ok");
}

const invoked = process.argv[1]
  ? fileURLToPath(import.meta.url) === process.argv[1] ||
    fileURLToPath(import.meta.url) === join(process.cwd(), process.argv[1])
  : false;

if (invoked) main();
