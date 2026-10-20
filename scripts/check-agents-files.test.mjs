import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentsFiles } from "./check-agents-files.mjs";

const SKILLS = [
  ".agents/skills/daily-maintenance/SKILL.md",
  ".agents/skills/release-guard/SKILL.md",
  ".agents/skills/review-loop/SKILL.md",
];

function tree() {
  return mkdtempSync(join(tmpdir(), "agents-files-"));
}

function writeSkills(root) {
  for (const rel of SKILLS) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# skill\n");
  }
}

function agents(bodyLines) {
  return `${bodyLines.join("\n")}\n`;
}

function validBody() {
  return [
    "# hq-jr",
    "",
    `Read \`${SKILLS[0]}\`.`,
    `Read \`${SKILLS[1]}\`.`,
    `Read \`${SKILLS[2]}\`.`,
  ];
}

const cases = [
  {
    name: "fails when AGENTS.md is missing",
    run() {
      const root = tree();
      try {
        const result = checkAgentsFiles(root);
        if (result.ok) throw new Error("expected a failure");
        if (!result.problems.some((p) => p.includes("AGENTS.md"))) {
          throw new Error(`expected AGENTS.md in ${result.problems}`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "fails when AGENTS.md is 121 lines",
    run() {
      const root = tree();
      try {
        writeSkills(root);
        const lines = validBody();
        while (lines.length < 121) lines.push("padding");
        writeFileSync(join(root, "AGENTS.md"), agents(lines));
        const result = checkAgentsFiles(root);
        if (result.ok) throw new Error("expected a failure");
        if (!result.problems.some((p) => p.includes("120"))) {
          throw new Error(`expected the budget in ${result.problems}`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "fails when a backtick path does not exist",
    run() {
      const root = tree();
      try {
        writeSkills(root);
        const lines = validBody();
        lines.push("See `docs/no-such-file.md`.");
        writeFileSync(join(root, "AGENTS.md"), agents(lines));
        const result = checkAgentsFiles(root);
        if (result.ok) throw new Error("expected a failure");
        if (!result.problems.some((p) => p.includes("docs/no-such-file.md"))) {
          throw new Error(`expected the missing path in ${result.problems}`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "fails on a ghp_ shape without printing the token",
    run() {
      const root = tree();
      const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
      try {
        writeSkills(root);
        const lines = validBody();
        lines.push(token);
        writeFileSync(join(root, "AGENTS.md"), agents(lines));
        const result = checkAgentsFiles(root);
        if (result.ok) throw new Error("expected a failure");
        const text = result.problems.join("\n");
        if (!text.includes("ghp_")) throw new Error(`expected the pattern name in ${text}`);
        if (text.includes(token)) throw new Error("the token was printed");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "passes a tree that meets every rule",
    run() {
      const root = tree();
      try {
        writeSkills(root);
        writeFileSync(join(root, "AGENTS.md"), agents(validBody()));
        const result = checkAgentsFiles(root);
        if (!result.ok) throw new Error(result.problems.join("\n"));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
];

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  return resolve(arg) === resolve(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  const failures = [];
  for (const testCase of cases) {
    try {
      testCase.run();
      console.log(`ok ${testCase.name}`);
    } catch (error) {
      failures.push(`${testCase.name}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("check-agents-files tests passed");
} else {
  const { describe, it } = await import("vitest");
  describe("checkAgentsFiles", () => {
    for (const testCase of cases) {
      it(testCase.name, () => {
        testCase.run();
      });
    }
  });
}
