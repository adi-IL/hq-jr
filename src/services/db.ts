import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { config } from "../config.js";

let defaultDbInstance: Database.Database | null = null;

export function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS remediation_commits (
      sha TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_remediation_commits_created_at ON remediation_commits (created_at);

    CREATE TABLE IF NOT EXISTS active_runs (
      run_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      started_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS symbol_cache (
      repo TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      symbols_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (repo, commit_sha, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_cache_repo_hash ON symbol_cache (repo, content_hash);
  `);
}

export function getDatabase(customPath?: string): Database.Database {
  if (customPath) {
    if (customPath !== ":memory:") {
      mkdirSync(dirname(customPath), { recursive: true });
    }
    const db = new Database(customPath);
    initSchema(db);
    return db;
  }

  if (!defaultDbInstance) {
    const dbPath = config.HQ_JR_DB_PATH;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    defaultDbInstance = new Database(dbPath);
    initSchema(defaultDbInstance);
  }

  return defaultDbInstance;
}

export function closeDatabase(): void {
  if (defaultDbInstance) {
    defaultDbInstance.close();
    defaultDbInstance = null;
  }
}

export function addRemediationCommit(sha: string, dbInstance?: Database.Database): void {
  const db = dbInstance ?? getDatabase();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO remediation_commits (sha, created_at) VALUES (?, ?)"
  );
  const prune = db.prepare(
    "DELETE FROM remediation_commits WHERE sha NOT IN (SELECT sha FROM remediation_commits ORDER BY created_at DESC LIMIT 1000)"
  );

  const transaction = db.transaction(() => {
    insert.run(sha, Date.now());
    prune.run();
  });

  transaction();
}

export function hasRemediationCommit(sha: string, dbInstance?: Database.Database): boolean {
  const db = dbInstance ?? getDatabase();
  const stmt = db.prepare("SELECT 1 FROM remediation_commits WHERE sha = ?");
  const row = stmt.get(sha);
  return Boolean(row);
}

export interface RunLockParams {
  runKey: string;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  ttlMs?: number;
}

export function acquireRunLock(params: RunLockParams, dbInstance?: Database.Database): boolean {
  const db = dbInstance ?? getDatabase();
  const now = Date.now();
  const ttl = params.ttlMs ?? 15 * 60 * 1000;

  const selectStmt = db.prepare<{ runKey: string }, { started_at: number }>(
    "SELECT started_at FROM active_runs WHERE run_key = :runKey"
  );
  const insertStmt = db.prepare(
    "INSERT INTO active_runs (run_key, owner, repo, pull_number, head_sha, started_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const updateStmt = db.prepare(
    "UPDATE active_runs SET owner = ?, repo = ?, pull_number = ?, head_sha = ?, started_at = ? WHERE run_key = ?"
  );

  const transaction = db.transaction((): boolean => {
    const existing = selectStmt.get({ runKey: params.runKey });
    if (existing) {
      if (now - existing.started_at < ttl) {
        return false;
      }
      updateStmt.run(params.owner, params.repo, params.pullNumber, params.headSha, now, params.runKey);
      return true;
    }

    insertStmt.run(params.runKey, params.owner, params.repo, params.pullNumber, params.headSha, now);
    return true;
  });

  return transaction();
}

export function releaseRunLock(runKey: string, dbInstance?: Database.Database): void {
  const db = dbInstance ?? getDatabase();
  const stmt = db.prepare("DELETE FROM active_runs WHERE run_key = ?");
  stmt.run(runKey);
}

export function isRunActive(runKey: string, ttlMs = 15 * 60 * 1000, dbInstance?: Database.Database): boolean {
  const db = dbInstance ?? getDatabase();
  const stmt = db.prepare<{ runKey: string }, { started_at: number }>(
    "SELECT started_at FROM active_runs WHERE run_key = :runKey"
  );
  const row = stmt.get({ runKey });
  if (!row) return false;
  return Date.now() - row.started_at < ttlMs;
}

export interface SymbolCacheParams {
  repo: string;
  commitSha: string;
  filePath: string;
  contentHash: string;
  symbolsJson: string;
}

export function setCachedSymbol(params: SymbolCacheParams, dbInstance?: Database.Database): void {
  const db = dbInstance ?? getDatabase();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO symbol_cache 
     (repo, commit_sha, file_path, content_hash, symbols_json, created_at) 
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    params.repo,
    params.commitSha,
    params.filePath,
    params.contentHash,
    params.symbolsJson,
    Date.now()
  );
}

export function getCachedSymbol(
  params: { repo: string; commitSha: string; filePath: string; contentHash?: string },
  dbInstance?: Database.Database
): string | null {
  const db = dbInstance ?? getDatabase();
  if (params.contentHash) {
    const stmt = db.prepare<{ repo: string; commitSha: string; filePath: string; contentHash: string }, { symbols_json: string }>(
      `SELECT symbols_json FROM symbol_cache 
       WHERE repo = :repo AND commit_sha = :commitSha AND file_path = :filePath AND content_hash = :contentHash`
    );
    const row = stmt.get(params as { repo: string; commitSha: string; filePath: string; contentHash: string });
    return row?.symbols_json ?? null;
  }

  const stmt = db.prepare<{ repo: string; commitSha: string; filePath: string }, { symbols_json: string }>(
    `SELECT symbols_json FROM symbol_cache 
     WHERE repo = :repo AND commit_sha = :commitSha AND file_path = :filePath`
  );
  const row = stmt.get({ repo: params.repo, commitSha: params.commitSha, filePath: params.filePath });
  return row?.symbols_json ?? null;
}
