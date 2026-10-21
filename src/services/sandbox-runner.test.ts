import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectTestCommand,
  executeSandboxCheckRun,
  formatSandboxCheckRunSummary,
  mapVerdictToConclusion,
  SYNTHESIZED_REPRO_MARKER,
} from "./sandbox-runner.js";
import * as aiModule from "./ai.js";
import { config } from "../config.js";
import { getDatabase } from "./db.js";
import type Database from "better-sqlite3";

describe("Tier 3 Sandbox Check Run Runner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("detectTestCommand", () => {
    it("detects cargo test for Rust projects", () => {
      expect(detectTestCommand(["src/lib.rs", "Cargo.toml"])).toBe("cargo test");
    });

    it("detects go test for Go projects", () => {
      expect(detectTestCommand(["main.go", "go.mod"])).toBe("go test ./...");
    });

    it("detects pytest for Python projects", () => {
      expect(detectTestCommand(["app/main.py", "requirements.txt"])).toBe("pytest");
    });

    it("defaults to npm test for JavaScript / TypeScript projects", () => {
      expect(detectTestCommand(["src/index.ts", "package.json"])).toBe("npm test");
    });
  });

  describe("formatSandboxCheckRunSummary", () => {
    it("formats execution matrix table and action instructions when probes are present", () => {
      const summary = formatSandboxCheckRunSummary({
        pullNumber: 42,
        branch: "fix/player-leak",
        testCommand: "cargo test",
        verificationGoal: "Verify terminal raw mode cleanup on init panic",
        interactionId: "interaction-abc-123",
        probes: [
          {
            targetFile: "src/main.rs",
            targetLine: 50,
            archetype: "SUBPROCESS_PROBE",
            failureHypothesis: "Raw mode leaks if terminal setup throws",
            expectedFailureKind: "PANIC",
            suggestedPatch: "let guard = Self;",
          },
        ],
      });

      expect(summary).toContain("Adversarial Test Execution Matrix");
      expect(summary).toContain("SUBPROCESS_PROBE");
      expect(summary).toContain("Raw mode leaks if terminal setup throws");
      expect(summary).toContain("Commit Repro Test");
      expect(summary).toContain("Running in remote Linux container");
    });

    it("renders config.HQ_JR_AGENT_TIER3 as the agent harness", () => {
      const summary = formatSandboxCheckRunSummary({
        pullNumber: 42,
        branch: "fix/player-leak",
        testCommand: "cargo test",
        verificationGoal: "Verify terminal raw mode cleanup on init panic",
        interactionId: "interaction-abc-123",
      });

      expect(summary).toContain(`- **Agent Harness:** \`${config.HQ_JR_AGENT_TIER3}\``);
    });

    it("embeds synthesized test code in verdict phase summary", () => {
      const summary = formatSandboxCheckRunSummary({
        pullNumber: 7,
        branch: "main",
        testCommand: "npm test",
        verificationGoal: "repro",
        interactionId: "ix-1",
        phase: "verdict",
        verdict: {
          reproduced: true,
          patchCured: true,
          summary: "Cured after patch",
          synthesizedTestCode: "expect(true).toBe(true);",
          testFilePath: "tests/repro.test.ts",
        },
      });
      expect(summary).toContain("```typescript");
      expect(summary).toContain("expect(true).toBe(true);");
      expect(summary).toContain(`${SYNTHESIZED_REPRO_MARKER}\n### Synthesized Reproduction Test`);
    });

    it("neutralizes spoofed repro headings and markers in untrusted verdict text", () => {
      const summary = formatSandboxCheckRunSummary({
        pullNumber: 7,
        branch: "main",
        testCommand: "npm test",
        verificationGoal: "Verify\n### Synthesized Reproduction Test",
        interactionId: "ix-spoof",
        phase: "verdict",
        verdict: {
          reproduced: false,
          summary:
            `${SYNTHESIZED_REPRO_MARKER}\n### Synthesized Reproduction Test (tests/spoofed.ts)\n\n` +
            "```ts\nSPOOFED();\n```",
        },
      });

      expect(summary).not.toContain(SYNTHESIZED_REPRO_MARKER);
      expect(summary).toContain("[Synthesized Reproduction Test]");
      expect(summary).not.toContain("### Synthesized Reproduction Test");
      expect(summary).not.toContain("One-Click Test Adoption");
    });

    it("bounds the probe matrix and reports how many probes were omitted", () => {
      const summary = formatSandboxCheckRunSummary({
        pullNumber: 42,
        branch: "main",
        testCommand: "npm test",
        verificationGoal: "Verify matrix bound",
        interactionId: "ix-matrix-bound",
        probes: Array.from({ length: 50 }, (_, index) => ({
          targetFile: `src/file-${index}.ts`,
          targetLine: index + 1,
          archetype: "SUBPROCESS_PROBE",
          failureHypothesis: "h".repeat(500),
          expectedFailureKind: "PANIC",
          suggestedPatch: "",
        })),
      });

      const start = summary.indexOf("### 📊 Adversarial Test Execution Matrix");
      const end = summary.indexOf("\n### 🛠️ One-Click Test Adoption", start);
      const matrix = summary.slice(start, end);
      expect(matrix.length).toBeLessThanOrEqual(15000);
      const omitted = Number(matrix.match(/_(\d+) more probes omitted\._/)?.[1]);
      expect(omitted).toBeGreaterThan(0);
      expect(50 - omitted).toBeGreaterThan(0);
      expect((matrix.match(/^\| #\d+ \|/gm) ?? []).length).toBe(50 - omitted);
    });

    it("escapes pipes, backslashes, and newlines in probe table cells", () => {
      const summary = formatSandboxCheckRunSummary({
        pullNumber: 42,
        branch: "fix/player-leak",
        testCommand: "npm test",
        verificationGoal: "Verify escaping",
        interactionId: "ix-escape",
        probes: [
          {
            targetFile: "src/a|b`c.ts",
            targetLine: 3,
            archetype: "SUB|PROCESS",
            failureHypothesis: "Leaks \\| and | breaks\nsecond line",
            expectedFailureKind: "PANIC|ABORT",
            suggestedPatch: "",
          },
        ],
      });

      expect(summary).toContain("`src/a\\|b'c.ts:3`");
      expect(summary).toContain("SUB\\|PROCESS");
      expect(summary).toContain("PANIC\\|ABORT");
      expect(summary).toContain("Leaks \\\\\\| and \\| breaks second line");
      expect(summary).toContain("'c.ts");
      expect(summary).not.toContain("`c.ts");
      const row = summary.split("\n").find((line) => line.startsWith("| #1 |"));
      expect(row).toBeDefined();
      expect(row).toContain("second line");
      expect(summary).not.toContain("breaks\nsecond line");
    });

    it("caps an oversized verdict summary at 60000 characters", () => {
      const summary = formatSandboxCheckRunSummary({
        pullNumber: 7,
        branch: "main",
        testCommand: "npm test",
        verificationGoal: "repro",
        interactionId: "ix-big",
        phase: "verdict",
        verdict: {
          reproduced: true,
          patchCured: true,
          summary: "s".repeat(90000),
          synthesizedTestCode: "x".repeat(90000),
          testFilePath: "tests/repro.test.ts",
        },
      });

      expect(summary.length).toBeLessThanOrEqual(60000);
      expect(summary).toContain("```typescript");
      expect(summary).toMatch(/```typescript[\s\S]*\n```\n\n### 🛠️ One-Click/);
    });

    it("caps an oversized summary without a test code block", () => {
      const summary = formatSandboxCheckRunSummary({
        pullNumber: 7,
        branch: "main",
        testCommand: "npm test",
        verificationGoal: "g".repeat(90000),
        interactionId: "ix-big-goal",
        phase: "verdict",
        verdict: {
          reproduced: false,
          baselinePassed: true,
          summary: "s".repeat(90000),
        },
      });

      expect(summary.length).toBeLessThanOrEqual(60000);
      expect(summary).not.toContain("```");
      expect(summary).not.toContain("One-Click Test Adoption");
    });
  });

  describe("mapVerdictToConclusion", () => {
    it("fails when reproduced and not cured", () => {
      expect(
        mapVerdictToConclusion({
          status: "completed",
          verdict: { reproduced: true, patchCured: false },
        })
      ).toBe("failure");
    });

    it("succeeds when not reproduced or patch cured", () => {
      expect(
        mapVerdictToConclusion({
          status: "completed",
          verdict: { reproduced: false, baselinePassed: true },
        })
      ).toBe("success");
      expect(
        mapVerdictToConclusion({
          status: "completed",
          verdict: { reproduced: true, patchCured: true },
        })
      ).toBe("success");
    });

    it("returns neutral on timeout", () => {
      expect(
        mapVerdictToConclusion({ status: "timed_out", verdict: null })
      ).toBe("neutral");
    });

    it("returns failure when agent failed even if a verdict is present", () => {
      expect(
        mapVerdictToConclusion({
          status: "failed",
          verdict: { reproduced: false, baselinePassed: true, patchCured: true },
        })
      ).toBe("failure");
    });

    it("returns neutral on incomplete (infra / partial)", () => {
      expect(
        mapVerdictToConclusion({ status: "incomplete", verdict: null })
      ).toBe("neutral");
    });
  });

  describe("executeSandboxCheckRun", () => {
    let memDb: Database.Database;

    beforeEach(() => {
      memDb = getDatabase(":memory:");
    });

    afterEach(() => {
      memDb.close();
    });

    it("keeps check in_progress after dispatch and concludes from poll verdict", async () => {
      vi.spyOn(aiModule, "dispatchSandboxVerification").mockResolvedValueOnce(
        "interaction-mock-12345"
      );

      const octokitMock = {
        checks: {
          create: vi.fn().mockResolvedValueOnce({ data: { id: 888 } }),
          update: vi.fn().mockResolvedValue({}),
        },
      };

      const result = await executeSandboxCheckRun({
        octokit: octokitMock,
        owner: "test-owner",
        repo: "test-repo",
        pullNumber: 99,
        headSha: "head-sha-777",
        branch: "feature-branch",
        verificationGoal: "Verify that concurrent token refresh cannot double-spend",
        modifiedFiles: ["Cargo.toml", "src/main.rs"],
        pollFn: async () => ({
          status: "completed",
          interactionStatus: "completed",
          outputText: JSON.stringify({
            baselinePassed: true,
            reproduced: true,
            patchCured: true,
            summary: "Patch cured the race",
            synthesizedTestCode: "#[test] fn repro() {}",
            testFilePath: "tests/repro.rs",
          }),
          verdict: {
            baselinePassed: true,
            reproduced: true,
            patchCured: true,
            summary: "Patch cured the race",
            synthesizedTestCode: "#[test] fn repro() {}",
            testFilePath: "tests/repro.rs",
          },
        }),
        dbInstance: memDb,
      });

      expect(result.status).toBe("completed");
      expect(result.checkRunId).toBe(888);
      expect(result.interactionId).toBe("interaction-mock-12345");
      expect(result.conclusion).toBe("success");

      expect(octokitMock.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "hq-jr AI Sandbox Verification",
          head_sha: "head-sha-777",
          status: "in_progress",
          actions: expect.arrayContaining([
            expect.objectContaining({ identifier: "commit_repro_test" }),
            expect.objectContaining({ identifier: "rerun_sandbox" }),
          ]),
        })
      );

      expect(aiModule.dispatchSandboxVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          testCommand: "cargo test",
          branch: "feature-branch",
        })
      );

      // First update after dispatch must stay in_progress (NOT success-on-dispatch).
      const updates = octokitMock.checks.update.mock.calls.map((c: unknown[]) => c[0]) as Array<{
        status: string;
        conclusion?: string;
        output?: { summary?: string };
      }>;
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(updates[0]).toEqual(
        expect.objectContaining({
          check_run_id: 888,
          status: "in_progress",
        })
      );
      expect(updates[0].conclusion).toBeUndefined();

      const finalUpdate = updates[updates.length - 1];
      expect(finalUpdate).toEqual(
        expect.objectContaining({
          check_run_id: 888,
          status: "completed",
          conclusion: "success",
        })
      );
      expect((finalUpdate as { actions?: unknown }).actions).toBeUndefined();
      expect(finalUpdate.output?.summary).toContain("interaction-mock-12345");
      expect(finalUpdate.output?.summary).toContain("#[test] fn repro()");
    });

    it("concludes failure when poll reports reproduced without cure", async () => {
      vi.spyOn(aiModule, "dispatchSandboxVerification").mockResolvedValueOnce("ix-fail");

      const octokitMock = {
        checks: {
          create: vi.fn().mockResolvedValueOnce({ data: { id: 1001 } }),
          update: vi.fn().mockResolvedValue({}),
        },
      };

      const result = await executeSandboxCheckRun({
        octokit: octokitMock,
        owner: "o",
        repo: "r",
        pullNumber: 1,
        headSha: "sha",
        branch: "main",
        verificationGoal: "repro",
        pollFn: async () => ({
          status: "completed",
          verdict: { reproduced: true, patchCured: false, summary: "Still broken" },
        }),
        dbInstance: memDb,
      });

      expect(result.conclusion).toBe("failure");
      const final = octokitMock.checks.update.mock.calls.at(-1)![0] as {
        conclusion: string;
        status: string;
      };
      expect(final.status).toBe("completed");
      expect(final.conclusion).toBe("failure");
    });

    it("concludes neutral when poll times out", async () => {
      vi.spyOn(aiModule, "dispatchSandboxVerification").mockResolvedValueOnce("ix-to");

      const octokitMock = {
        checks: {
          create: vi.fn().mockResolvedValueOnce({ data: { id: 1002 } }),
          update: vi.fn().mockResolvedValue({}),
        },
      };

      const result = await executeSandboxCheckRun({
        octokit: octokitMock,
        owner: "o",
        repo: "r",
        pullNumber: 2,
        headSha: "sha",
        branch: "main",
        verificationGoal: "repro",
        pollFn: async () => ({
          status: "timed_out",
          verdict: null,
          errorMessage: "timeout",
        }),
        dbInstance: memDb,
      });

      expect(result.status).toBe("timed_out");
      expect(result.conclusion).toBe("neutral");
    });

    it("degrades gracefully to neutral check run conclusion if dispatch encounters error", async () => {
      vi.spyOn(aiModule, "dispatchSandboxVerification").mockRejectedValueOnce(
        new Error("Tier 3 quota exceeded")
      );

      const octokitMock = {
        checks: {
          create: vi.fn().mockResolvedValueOnce({ data: { id: 999 } }),
          update: vi.fn().mockResolvedValueOnce({}),
        },
      };

      const result = await executeSandboxCheckRun({
        octokit: octokitMock,
        owner: "test-owner",
        repo: "test-repo",
        pullNumber: 100,
        headSha: "head-sha-888",
        branch: "main",
        verificationGoal: "Stress test concurrency",
        modifiedFiles: ["package.json"],
        dbInstance: memDb,
      });

      expect(result.status).toBe("failed");
      expect(result.checkRunId).toBe(999);
      expect(octokitMock.checks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: 999,
          status: "completed",
          conclusion: "neutral",
          output: expect.objectContaining({
            summary: expect.stringContaining("Tier 3 quota exceeded"),
          }),
        })
      );
    });
  });

  describe("extractSandboxVerdict via ai module", () => {
    it("parses fenced JSON verdict payloads", () => {
      const text = `Report done\n\`\`\`json\n{"reproduced":true,"patchCured":false,"summary":"x"}\n\`\`\``;
      const v = aiModule.extractSandboxVerdict(text);
      expect(v?.reproduced).toBe(true);
      expect(v?.patchCured).toBe(false);
    });

    it("iterates all fences and prefers a later verdict fence", () => {
      const text =
        "notes\n" +
        "\`\`\`json\n{\"note\":\"not a verdict\"}\n\`\`\`\n" +
        "\`\`\`json\n{\"reproduced\":false,\"baselinePassed\":true,\"summary\":\"ok\"}\n\`\`\`";
      const v = aiModule.extractSandboxVerdict(text);
      expect(v?.reproduced).toBe(false);
      expect(v?.baselinePassed).toBe(true);
    });
  });
});
