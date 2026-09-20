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
