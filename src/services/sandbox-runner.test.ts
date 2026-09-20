import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectTestCommand,
  executeSandboxCheckRun,
  formatSandboxCheckRunSummary,
} from "./sandbox-runner.js";
import * as aiModule from "./ai.js";

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
    });
  });

  describe("executeSandboxCheckRun", () => {
    it("creates an in-progress check run, dispatches verification, and completes check run", async () => {
      vi.spyOn(aiModule, "dispatchSandboxVerification").mockResolvedValueOnce(
        "interaction-mock-12345"
      );

      const octokitMock = {
        checks: {
          create: vi.fn().mockResolvedValueOnce({ data: { id: 888 } }),
          update: vi.fn().mockResolvedValueOnce({}),
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
      });

      expect(result.status).toBe("dispatched");
      expect(result.checkRunId).toBe(888);
      expect(result.interactionId).toBe("interaction-mock-12345");

      expect(octokitMock.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "hq-jr AI Sandbox Verification",
          head_sha: "head-sha-777",
          status: "in_progress",
          actions: expect.arrayContaining([
            expect.objectContaining({ identifier: "commit_repro_test" }),
          ]),
        })
      );

      expect(aiModule.dispatchSandboxVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          testCommand: "cargo test",
          branch: "feature-branch",
        })
      );

      expect(octokitMock.checks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: 888,
          status: "completed",
          conclusion: "success",
          output: expect.objectContaining({
            summary: expect.stringContaining("interaction-mock-12345"),
          }),
        })
      );
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
});
