import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDatabase } from "./db.js";
import {
  computeContentHash,
  cacheSymbols,
  getCachedSymbols,
  isContentUnmodified,
  ExtractedSymbol,
} from "./symbol-cache.js";
import type Database from "better-sqlite3";

describe("Symbol and Content Hash Cache Engine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = getDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("computes deterministic SHA-256 content hashes", () => {
    const hash1 = computeContentHash("export function hello() {}");
    const hash2 = computeContentHash("export function hello() {}");
    const hash3 = computeContentHash("export function goodbye() {}");

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toHaveLength(64);
  });

  it("caches and retrieves symbols for a file version", () => {
    const symbols: ExtractedSymbol[] = [
      { name: "authenticateUser", kind: "function", line: 12, exported: true },
      { name: "AuthToken", kind: "interface", line: 30, exported: true },
    ];

    const content = "export function authenticateUser() {} export interface AuthToken {}";
    const contentHash = cacheSymbols({
      repo: "octocat/hello-world",
      commitSha: "commit-aaa",
      filePath: "src/auth.ts",
      content,
      symbols,
      db,
    });

    expect(contentHash).toHaveLength(64);

    const retrieved = getCachedSymbols({
      repo: "octocat/hello-world",
      commitSha: "commit-aaa",
      filePath: "src/auth.ts",
      content,
      db,
    });

    expect(retrieved).toEqual(symbols);
  });

  it("returns null when content has changed from cached version", () => {
    const symbols: ExtractedSymbol[] = [
      { name: "init", kind: "function", line: 1, exported: true },
    ];

    cacheSymbols({
      repo: "octocat/hello-world",
      commitSha: "commit-aaa",
      filePath: "src/init.ts",
      content: "export function init() {}",
      symbols,
      db,
    });

    const retrieved = getCachedSymbols({
      repo: "octocat/hello-world",
      commitSha: "commit-aaa",
      filePath: "src/init.ts",
      content: "export function init() { console.log('modified'); }",
      db,
    });

    expect(retrieved).toBeNull();
  });

  it("verifies whether file content is unmodified for incremental indexing", () => {
    const originalContent = "const version = 1;";
    cacheSymbols({
      repo: "octocat/hello-world",
      commitSha: "commit-1",
      filePath: "src/version.ts",
      content: originalContent,
      symbols: [{ name: "version", kind: "constant", line: 1, exported: false }],
      db,
    });

    expect(
      isContentUnmodified({
        repo: "octocat/hello-world",
        commitSha: "commit-1",
        filePath: "src/version.ts",
        content: originalContent,
        db,
      })
    ).toBe(true);

    expect(
      isContentUnmodified({
        repo: "octocat/hello-world",
        commitSha: "commit-1",
        filePath: "src/version.ts",
        content: "const version = 2;",
        db,
      })
    ).toBe(false);
  });
});
