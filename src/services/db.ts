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

    CREATE TABLE IF NOT EXISTS review_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      path TEXT NOT NULL,
      line INTEGER,
      side TEXT,
      severity TEXT,
      title TEXT,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_findings_pr
      ON review_findings (owner, repo, pull_number, created_at);
    CREATE INDEX IF NOT EXISTS idx_review_findings_pr_sha
      ON review_findings (owner, repo, pull_number, head_sha);

    CREATE TABLE IF NOT EXISTS sandbox_jobs (
      interaction_id TEXT PRIMARY KEY,
      check_run_id INTEGER NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      branch TEXT,
      verification_goal TEXT,
      probes_json TEXT,
      test_command TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'dispatched'
    );
    CREATE INDEX IF NOT EXISTS idx_sandbox_jobs_check
      ON sandbox_jobs (owner, repo, check_run_id);
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


export interface ReviewFindingRow {
  id?: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  path: string;
  line?: number | null;
  side?: string | null;
  severity?: string | null;
  title?: string | null;
  body: string;
  createdAt?: number;
}

export function saveReviewFindings(
  findings: ReviewFindingRow[],
  dbInstance?: Database.Database
): void {
  if (findings.length === 0) return;
  const db = dbInstance ?? getDatabase();
  const insert = db.prepare(
    `INSERT INTO review_findings
      (owner, repo, pull_number, head_sha, path, line, side, severity, title, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction((rows: ReviewFindingRow[]) => {
    const now = Date.now();
    for (const f of rows) {
      insert.run(
        f.owner,
        f.repo,
        f.pullNumber,
        f.headSha,
        f.path,
        f.line ?? null,
        f.side ?? null,
        f.severity ?? null,
        f.title ?? null,
        f.body,
        f.createdAt ?? now
      );
    }
  });
  tx(findings);
}

export function getReviewFindingsForPull(
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    excludeHeadSha?: string;
  },
  dbInstance?: Database.Database
): ReviewFindingRow[] {
  const db = dbInstance ?? getDatabase();
  type Row = {
    id: number;
    owner: string;
    repo: string;
    pull_number: number;
    head_sha: string;
    path: string;
    line: number | null;
    side: string | null;
    severity: string | null;
    title: string | null;
    body: string;
    created_at: number;
  };

  let rows: Row[];
  if (params.excludeHeadSha) {
    const stmt = db.prepare<
      { owner: string; repo: string; pullNumber: number; excludeHeadSha: string },
      Row
    >(
      `SELECT * FROM review_findings
       WHERE owner = :owner AND repo = :repo AND pull_number = :pullNumber
         AND head_sha != :excludeHeadSha
       ORDER BY created_at ASC`
    );
    rows = stmt.all({
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      excludeHeadSha: params.excludeHeadSha,
    });
  } else {
    const stmt = db.prepare<
      { owner: string; repo: string; pullNumber: number },
      Row
    >(
      `SELECT * FROM review_findings
       WHERE owner = :owner AND repo = :repo AND pull_number = :pullNumber
       ORDER BY created_at ASC`
    );
    rows = stmt.all({
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
    });
  }

  return rows.map((r) => ({
    id: r.id,
    owner: r.owner,
    repo: r.repo,
    pullNumber: r.pull_number,
    headSha: r.head_sha,
    path: r.path,
    line: r.line,
    side: r.side,
    severity: r.severity,
    title: r.title,
    body: r.body,
    createdAt: r.created_at,
  }));
}

export interface SandboxJobRow {
  interactionId: string;
  checkRunId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  branch?: string | null;
  verificationGoal?: string | null;
  probesJson?: string | null;
  testCommand?: string | null;
  status?: string;
}

export function upsertSandboxJob(job: SandboxJobRow, dbInstance?: Database.Database): void {
  const db = dbInstance ?? getDatabase();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO sandbox_jobs
      (interaction_id, check_run_id, owner, repo, pull_number, head_sha, branch,
       verification_goal, probes_json, test_command, created_at, updated_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(interaction_id) DO UPDATE SET
       check_run_id = excluded.check_run_id,
       branch = excluded.branch,
       verification_goal = excluded.verification_goal,
       probes_json = excluded.probes_json,
       test_command = excluded.test_command,
       updated_at = excluded.updated_at,
       status = excluded.status`
  );
  stmt.run(
    job.interactionId,
    job.checkRunId,
    job.owner,
    job.repo,
    job.pullNumber,
    job.headSha,
    job.branch ?? null,
    job.verificationGoal ?? null,
    job.probesJson ?? null,
    job.testCommand ?? null,
    now,
    now,
    job.status ?? "dispatched"
  );
}

export function updateSandboxJobStatus(
  interactionId: string,
  status: string,
  dbInstance?: Database.Database
): void {
  const db = dbInstance ?? getDatabase();
  db.prepare(
    "UPDATE sandbox_jobs SET status = ?, updated_at = ? WHERE interaction_id = ?"
  ).run(status, Date.now(), interactionId);
}

export function getSandboxJobByCheckRun(
  params: { owner: string; repo: string; checkRunId: number },
  dbInstance?: Database.Database
): SandboxJobRow | null {
  const db = dbInstance ?? getDatabase();
  type Row = {
    interaction_id: string;
    check_run_id: number;
    owner: string;
    repo: string;
    pull_number: number;
    head_sha: string;
    branch: string | null;
    verification_goal: string | null;
    probes_json: string | null;
    test_command: string | null;
    status: string;
  };
  const row = db
    .prepare<{ owner: string; repo: string; checkRunId: number }, Row>(
      `SELECT * FROM sandbox_jobs
       WHERE owner = :owner AND repo = :repo AND check_run_id = :checkRunId
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(params);
  if (!row) return null;
  return {
    interactionId: row.interaction_id,
    checkRunId: row.check_run_id,
    owner: row.owner,
    repo: row.repo,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    branch: row.branch,
    verificationGoal: row.verification_goal,
    probesJson: row.probes_json,
    testCommand: row.test_command,
    status: row.status,
  };
}
