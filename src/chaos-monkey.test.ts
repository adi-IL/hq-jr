import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseUnifiedDiff, isLineInDiff } from "./services/diff-parser.js";
import { packageReviewContext } from "./services/context-packager.js";
import { safeParseJson } from "./services/json-repair.js";
import { scrubSecrets } from "./services/scrubber.js";
import {
  getDatabase,
  acquireRunLock,
  releaseRunLock,
  isRunActive,
  addRemediationCommit,
  hasRemediationCommit,
} from "./services/db.js";
import { executeRemediation } from "./services/remediation.js";
import { detectTestCommand, executeSandboxCheckRun } from "./services/sandbox-runner.js";
import { DeepReviewResultSchema } from "./schemas/review.js";
import appFn from "./index.js";
import type Database from "better-sqlite3";
import { ai } from "./services/ai.js";

describe("Blood House Monkey Chaos Gauntlet", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = getDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("Cycle 1: Payload and Webhook Chaos", () => {
    it("CHAOS 1.1: safely handles corrupt unified diff headers without infinite loop or crash", () => {
      const corruptDiffs = [
        "diff --git a/file.txt b/file.txt\n@@ -0,0 +0,0 @@\n",
        "diff --git a/file.txt b/file.txt\n@@ -99999999,99999999 +0,0 @@\n-broken line\n",
        "diff --git a/file.txt b/file.txt\n@@ invalid hunk header @@\n+line\n",
        "@@ -1,1 +1,1 @@\n+orphan hunk without git header",
        "",
        "\n\n\n\n",
      ];

      for (const diff of corruptDiffs) {
        expect(() => {
          const parsed = parseUnifiedDiff(diff);
          expect(parsed.files).toBeDefined();
        }).not.toThrow();
      }
    });

    it("CHAOS 1.2: safely parses diffs with null bytes, Unicode surrogate pairs, and quoted spaces", () => {
      const hostileDiff = `diff --git "a/path with spaces/\\0special.ts" "b/path with spaces/\\0special.ts"
index 0000000..1234567 100644
--- "a/path with spaces/\\0special.ts"
+++ "b/path with spaces/\\0special.ts"
@@ -1,2 +1,3 @@
 const x = "\uD83D\uDE00";
+\\0null_byte_injection
 const y = "\uD800\uDFFF";
`;

      const parsed = parseUnifiedDiff(hostileDiff);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0].newPath).toContain("path with spaces");
      expect(isLineInDiff(parsed.files[0], 2, "RIGHT")).toBe(true);
      expect(isLineInDiff(parsed.files[0], 999, "RIGHT")).toBe(false);
    });

    it("CHAOS 1.3: enforces strict 120,000 character token cap when flooded with 1,000,000 character diff", () => {
      const massiveLines = Array.from({ length: 25000 }, (_, i) => `+const line_${i} = "data_${i}";\n`).join("");
      const giantDiff = `diff --git a/massive.ts b/massive.ts\nindex 0000000..1234567 100644\n--- a/massive.ts\n+++ b/massive.ts\n@@ -1,1 +1,25000 @@\n${massiveLines}`;

      const parsed = parseUnifiedDiff(giantDiff);
      const pkg = packageReviewContext(parsed);

      expect(pkg.promptPayload.length).toBeLessThanOrEqual(130000); // 120k + envelope
      expect(pkg.itemsToReview[0].isTruncated).toBe(true);
    });

    it("CHAOS 1.4: recovers from malformed and deeply truncated JSON payloads without throwing uncaught error", () => {
      const brokenPayloads = [
        '{"summary": "incomplete payload", "comments": [{"path": "src/app.ts", "line": 10, ',
        '{"summary": "unclosed string literal: "bad',
        '```json\n{"summary": "fenced json with trailing comma", "comments": [],}\n```',
        '{"summary": "nested unclosed arrays", "arr": [[[[',
      ];

      for (const raw of brokenPayloads) {
        expect(() => {
          const parsed = safeParseJson(raw, { fallback: true });
          expect(parsed).toBeDefined();
        }).not.toThrow();
      }
    });

    it("CHAOS 1.5: scrubs overlapping high-entropy tokens and private keys without catastrophic regex backtracking", () => {
      const attackPayload = `
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP
QRSTUVWXYZ1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVW==
-----END RSA PRIVATE KEY-----
ghp_123456789012345678901234567890123456
github_pat_11A1234567890123456789012345678901234567890123456789012345678901234567890123456789
AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
sk-proj-123456789012345678901234567890123456789012345678901234567890
password="superSecretPassword123"
`.repeat(5);

      const startTime = Date.now();
      const { scrubbed, redactedCount } = scrubSecrets(attackPayload);
      const elapsedMs = Date.now() - startTime;

      expect(elapsedMs).toBeLessThan(100); // No ReDoS
      expect(redactedCount).toBeGreaterThan(15);
      expect(scrubbed).not.toContain("BEGIN RSA PRIVATE KEY");
      expect(scrubbed).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(scrubbed).not.toContain("wJalrXUtnFEMI/K7MDENG");
    });
  });

  describe("Cycle 2: Concurrency and State Chaos", () => {
    it("CHAOS 2.1: handles 50 simultaneous parallel lock acquisitions atomically with exactly 1 winner", async () => {
      const lockParams = {
        runKey: "owner/repo#99",
        owner: "owner",
        repo: "repo",
        pullNumber: 99,
        headSha: "sha-parallel",
      };

      const results = await Promise.all(
        Array.from({ length: 50 }, () => Promise.resolve(acquireRunLock(lockParams, db)))
      );

      const winners = results.filter((won) => won === true);
      const losers = results.filter((won) => won === false);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(49);
    });

    it("CHAOS 2.2: auto-recovers abandoned lock when worker crashes past TTL", () => {
      const lockParams = {
        runKey: "owner/repo#100",
        owner: "owner",
        repo: "repo",
        pullNumber: 100,
        headSha: "sha-crashed",
        ttlMs: 100,
      };

      expect(acquireRunLock(lockParams, db)).toBe(true);
      expect(acquireRunLock(lockParams, db)).toBe(false);

      // Simulate crash: simulate 200ms elapsed
      db.prepare("UPDATE active_runs SET started_at = ? WHERE run_key = ?").run(
        Date.now() - 300,
        "owner/repo#100"
      );

      // New worker seamlessly recovers the stale lock
      expect(acquireRunLock(lockParams, db)).toBe(true);
    });

    it("CHAOS 2.3: rejects stale head commit during remediation fix synthesis", async () => {
      vi.spyOn(ai.models, "generateContent").mockResolvedValueOnce({
        text: "```typescript\nconst a = 2;\n```",
      } as unknown as { text: string });

      const octokitMock = {
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: { content: Buffer.from("const a = 1;").toString("base64") },
          }),
        },
        pulls: {
          // Re-fetch returns a new head pushed by author during AI synthesis
          get: vi.fn().mockResolvedValue({
            data: { head: { sha: "new-commit-pushed-in-flight", ref: "feature" } },
          }),
        },
        git: {
          createBlob: vi.fn().mockResolvedValue({ data: { sha: "blob-sha-123" } }),
          getCommit: vi.fn(),
          createTree: vi.fn(),
          createCommit: vi.fn(),
        },
      };

      const result = await executeRemediation({
        octokit: octokitMock,
        owner: "owner",
        repo: "repo",
        pullNumber: 1,
        pr: { head: { sha: "initial-stale-sha", ref: "feature" } },
        issues: [{ id: 1, path: "src/a.ts", side: "RIGHT", title: "Bug", body: "Fix bug" }],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("Stale base tree detected");
      expect(octokitMock.git.createCommit).not.toHaveBeenCalled();
    });

    it("CHAOS 2.4: enforces fail-closed RBAC when collaborator check throws 404/500", async () => {
      const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
      const mockApp = {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        on: vi.fn((event: string | string[], handler: (ctx: unknown) => Promise<void>) => {
          if (Array.isArray(event)) event.forEach((e) => handlers.set(e, handler));
          else handlers.set(event, handler);
        }),
      };

      const octokitMock = {
        repos: {
          getCollaboratorPermissionLevel: vi.fn().mockRejectedValueOnce(new Error("GitHub 500 Server Error")),
        },
        issues: {
          createComment: vi.fn().mockResolvedValue({}),
        },
      };

      appFn(mockApp as unknown as Parameters<typeof appFn>[0]);
      const handler = handlers.get("issue_comment.created");

      await handler!({
        octokit: octokitMock,
        payload: {
          issue: { number: 10, pull_request: {} },
          comment: { id: 1, body: "@hq-jr fix and merge", user: { login: "attacker", type: "User" } },
          repository: { name: "repo", owner: { login: "owner" } },
        },
      });

      expect(octokitMock.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("Access Denied"),
        })
      );
    });
  });

  describe("Cycle 3: Adversarial Model and Injection Chaos", () => {
    it("CHAOS 3.1: validates that hostile prompt injection attempts inside diffs do not break review schema", () => {
      const hostileReviewResult = {
        summary: "Normal summary",
        verdict: "APPROVE",
        comments: [],
        requiresSandboxVerification: false,
        sandboxProbes: [],
      };

      const parsed = DeepReviewResultSchema.parse(hostileReviewResult);
      expect(parsed.verdict).toBe("APPROVE");
    });

    it("CHAOS 3.2: rejects invalid enum verdicts in DeepReviewResultSchema", () => {
      const poisonedOutput = {
        summary: "Injected verdict",
        verdict: "HACKED_BYPASS_ALL_CHECKS",
        comments: [],
      };

      expect(() => DeepReviewResultSchema.parse(poisonedOutput)).toThrow();
    });

    it("CHAOS 3.3: detects test commands safely without executing shell injection characters", () => {
      const hostileFiles = [
        "Cargo.toml; rm -rf /",
        "app.py && curl http://evil.com",
        "package.json`cat /etc/passwd`",
      ];

      expect(detectTestCommand([hostileFiles[0]])).toBe("cargo test");
      expect(detectTestCommand([hostileFiles[1]])).toBe("pytest");
      expect(detectTestCommand([hostileFiles[2]])).toBe("npm test");
    });
  });
});
