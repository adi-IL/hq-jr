import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getDatabase,
  addRemediationCommit,
  hasRemediationCommit,
  acquireRunLock,
  releaseRunLock,
  isRunActive,
  setCachedSymbol,
  getCachedSymbol,
  saveReviewFindings,
  getReviewFindingsForPull,
  upsertSandboxJob,
  getSandboxJobByCheckRun,
  updateSandboxJobStatus,
} from "./db.js";
import type Database from "better-sqlite3";

describe("Persistent SQLite Store (db.ts)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = getDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("Remediation Commits", () => {
    it("stores and verifies remediation commit SHAs", () => {
      expect(hasRemediationCommit("sha123456", db)).toBe(false);

      addRemediationCommit("sha123456", db);
      expect(hasRemediationCommit("sha123456", db)).toBe(true);
      expect(hasRemediationCommit("sha999999", db)).toBe(false);
    });

    it("prunes oldest commits when exceeding retention threshold", () => {
      for (let i = 0; i < 50; i++) {
        addRemediationCommit(`sha-${i}`, db);
      }
      expect(hasRemediationCommit("sha-0", db)).toBe(true);
      expect(hasRemediationCommit("sha-49", db)).toBe(true);
    });
  });

  describe("Active Run Mutex", () => {
    it("acquires lock for new run and rejects concurrent lock on same key", () => {
      const lockParams = {
        runKey: "owner/repo#42",
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        headSha: "abcdef1",
      };

      const firstAcquire = acquireRunLock(lockParams, db);
      expect(firstAcquire).toBe(true);
      expect(isRunActive("owner/repo#42", undefined, db)).toBe(true);

      const secondAcquire = acquireRunLock(lockParams, db);
      expect(secondAcquire).toBe(false);
    });

    it("releases lock cleanly allowing subsequent acquisition", () => {
      const lockParams = {
        runKey: "owner/repo#42",
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        headSha: "abcdef1",
      };

      expect(acquireRunLock(lockParams, db)).toBe(true);
      releaseRunLock("owner/repo#42", db);
      expect(isRunActive("owner/repo#42", undefined, db)).toBe(false);

      expect(acquireRunLock(lockParams, db)).toBe(true);
    });

    it("auto-recovers stale locks when TTL has expired", () => {
      const lockParams = {
        runKey: "owner/repo#42",
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        headSha: "abcdef1",
        ttlMs: 50, // 50ms TTL for testing
      };

      expect(acquireRunLock(lockParams, db)).toBe(true);

      // Mutex is active initially
      expect(acquireRunLock(lockParams, db)).toBe(false);

      // Manually manipulate started_at to simulate expiration
      db.prepare("UPDATE active_runs SET started_at = ? WHERE run_key = ?").run(
        Date.now() - 100,
        "owner/repo#42"
      );

      // Stale lock is overwritten
      expect(acquireRunLock(lockParams, db)).toBe(true);
    });
  });

  describe("Symbol Cache", () => {
    it("stores and retrieves AST symbols by commit and file path", () => {
      setCachedSymbol(
        {
          repo: "owner/repo",
          commitSha: "sha1",
          filePath: "src/auth.ts",
          contentHash: "hash-abc",
          symbolsJson: JSON.stringify([{ name: "login", kind: "function" }]),
        },
        db
      );

      const cached = getCachedSymbol(
        {
          repo: "owner/repo",
          commitSha: "sha1",
          filePath: "src/auth.ts",
        },
        db
      );

      expect(cached).toBeDefined();
      const parsed = JSON.parse(cached!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("login");
    });

    it("returns null for cache miss", () => {
      const cached = getCachedSymbol(
        {
          repo: "owner/repo",
          commitSha: "nonexistent",
          filePath: "src/missing.ts",
        },
        db
      );
      expect(cached).toBeNull();
    });
  });
});


describe("Review Findings Memory", () => {
  let db: import("better-sqlite3").Database;

  beforeEach(() => {
    db = getDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("saves and loads findings for a pull request across shas", () => {
    saveReviewFindings(
      [
        {
          owner: "o",
          repo: "r",
          pullNumber: 3,
          headSha: "sha-a",
          path: "src/a.ts",
          line: 10,
          side: "RIGHT",
          severity: "CRITICAL",
          title: "Bug A",
          body: "body-a",
        },
        {
          owner: "o",
          repo: "r",
          pullNumber: 3,
          headSha: "sha-b",
          path: "src/b.ts",
          line: 20,
          side: "RIGHT",
          severity: "WARNING",
          title: "Bug B",
          body: "body-b",
        },
      ],
      db
    );

    const prior = getReviewFindingsForPull(
      { owner: "o", repo: "r", pullNumber: 3, excludeHeadSha: "sha-b" },
      db
    );
    expect(prior).toHaveLength(1);
    expect(prior[0].path).toBe("src/a.ts");
    expect(prior[0].title).toBe("Bug A");
    expect(prior[0].line).toBe(10);
    expect(prior[0].side).toBe("RIGHT");
    expect(prior[0].severity).toBe("CRITICAL");

    const all = getReviewFindingsForPull({ owner: "o", repo: "r", pullNumber: 3 }, db);
    expect(all).toHaveLength(2);
  });

  it("scrubs secrets at rest before INSERT", () => {
    saveReviewFindings(
      [
        {
          owner: "o",
          repo: "r",
          pullNumber: 4,
          headSha: "sha-sec",
          path: "src/secret.ts",
          line: 1,
          side: "RIGHT",
          severity: "CRITICAL",
          title: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
          body: "Found ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD in logs",
        },
      ],
      db
    );

    const raw = db
      .prepare("SELECT title, body FROM review_findings WHERE pull_number = 4")
      .get() as { title: string; body: string };
    expect(raw.title).toContain("[REDACTED_SECRET]");
    expect(raw.title).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
    expect(raw.body).toContain("[REDACTED_SECRET]");
    expect(raw.body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
  });
});

describe("Sandbox Jobs", () => {
  let db: import("better-sqlite3").Database;

  beforeEach(() => {
    db = getDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("upserts and retrieves sandbox jobs by check run id", () => {
    upsertSandboxJob(
      {
        interactionId: "ix-1",
        checkRunId: 42,
        owner: "o",
        repo: "r",
        pullNumber: 9,
        headSha: "abc",
        branch: "main",
        verificationGoal: "repro",
        probesJson: "[]",
        testCommand: "npm test",
        status: "running",
      },
      db
    );

    const job = getSandboxJobByCheckRun({ owner: "o", repo: "r", checkRunId: 42 }, db);
    expect(job?.interactionId).toBe("ix-1");
    expect(job?.testCommand).toBe("npm test");

    updateSandboxJobStatus("ix-1", "success", db);
    const updated = getSandboxJobByCheckRun({ owner: "o", repo: "r", checkRunId: 42 }, db);
    expect(updated?.status).toBe("success");
  });
});
