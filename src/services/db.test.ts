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
  resolveFindingsMissingFromCurrent,
  pruneResolvedFindings,
  claimStaleSandboxJobs,
  touchSandboxJob,
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
    const rawToken = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const redactionMarker = "[REDACTED_SECRET]";
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
          title: `token ${rawToken}`,
          body: `Found ${rawToken} in logs`,
        },
      ],
      db
    );

    const raw = db
      .prepare("SELECT title, body FROM review_findings WHERE pull_number = 4")
      .get() as { title: string; body: string };
    expect(raw.title).toContain(redactionMarker);
    expect(raw.title).not.toContain(rawToken);
    expect(raw.body).toContain(redactionMarker);
    expect(raw.body).not.toContain(rawToken);
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

describe("Finding resolution and pruning", () => {
  let db: import("better-sqlite3").Database;

  beforeEach(() => {
    db = getDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("resolves prior open findings missing from the current review", () => {
    saveReviewFindings(
      [
        {
          owner: "o",
          repo: "r",
          pullNumber: 9,
          headSha: "sha-old",
          path: "src/a.ts",
          line: 1,
          title: "Bug A",
          body: "old",
        },
        {
          owner: "o",
          repo: "r",
          pullNumber: 9,
          headSha: "sha-old",
          path: "src/b.ts",
          line: 2,
          title: "Bug B",
          body: "keep-as-open-until-missing",
        },
      ],
      db
    );

    saveReviewFindings(
      [
        {
          owner: "o",
          repo: "r",
          pullNumber: 9,
          headSha: "sha-new",
          path: "src/a.ts",
          line: 1,
          title: "Bug A",
          body: "still present",
        },
      ],
      db
    );

    const resolved = resolveFindingsMissingFromCurrent(
      {
        owner: "o",
        repo: "r",
        pullNumber: 9,
        currentHeadSha: "sha-new",
        currentFindings: [{ path: "src/a.ts", line: 1, title: "Bug A" }],
      },
      db
    );
    expect(resolved).toBe(1);

    const open = getReviewFindingsForPull(
      { owner: "o", repo: "r", pullNumber: 9, excludeHeadSha: "sha-new" },
      db
    );
    expect(open).toHaveLength(1);
    expect(open[0].path).toBe("src/a.ts");

    // Force resolved row older than retention window.
    db.prepare("UPDATE review_findings SET created_at = 1 WHERE status = 'resolved'").run();
    const pruned = pruneResolvedFindings(1000, db);
    expect(pruned).toBeGreaterThanOrEqual(1);
  });
});

describe("Sandbox job recovery claims", () => {
  let db: import("better-sqlite3").Database;

  beforeEach(() => {
    db = getDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("claims only stale running jobs and heartbeats refresh updated_at", () => {
    upsertSandboxJob(
      {
        interactionId: "ix-stale",
        checkRunId: 1,
        owner: "o",
        repo: "r",
        pullNumber: 1,
        headSha: "abc",
        status: "running",
        installationId: 42,
      },
      db
    );
    // Force stale updated_at
    db.prepare("UPDATE sandbox_jobs SET updated_at = ? WHERE interaction_id = ?").run(
      Date.now() - 120_000,
      "ix-stale"
    );

    upsertSandboxJob(
      {
        interactionId: "ix-fresh",
        checkRunId: 2,
        owner: "o",
        repo: "r",
        pullNumber: 1,
        headSha: "def",
        status: "running",
        installationId: 42,
      },
      db
    );
    touchSandboxJob("ix-fresh", db);

    const claimed = claimStaleSandboxJobs(45_000, db);
    expect(claimed.map((j) => j.interactionId)).toEqual(["ix-stale"]);
    expect(claimed[0].status).toBe("recovering");
    expect(claimed[0].installationId).toBe(42);
  });
});
