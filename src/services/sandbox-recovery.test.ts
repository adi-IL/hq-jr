import { describe, it, expect, vi } from "vitest";
import { resumeStaleSandboxJobs } from "./sandbox-runner.js";
import { getDatabase, upsertSandboxJob } from "./db.js";

function legacyJob(db: import("better-sqlite3").Database, id: string) {
  upsertSandboxJob(
    { interactionId: id, checkRunId: 7, owner: "o", repo: "r", pullNumber: 1, headSha: "abc", status: "running" },
    db
  );
  db.prepare("UPDATE sandbox_jobs SET installation_id = NULL, updated_at = ? WHERE interaction_id = ?").run(
    Date.now() - 120_000,
    id
  );
}

function row(db: import("better-sqlite3").Database, id: string) {
  return db.prepare("SELECT status, installation_id FROM sandbox_jobs WHERE interaction_id = ?").get(id) as {
    status: string;
    installation_id: number | null;
  };
}

describe("resumeStaleSandboxJobs with legacy rows", () => {
  it("backfills installation_id from the repo and recovers the job", async () => {
    const db = getDatabase(":memory:");
    legacyJob(db, "ix-legacy");
    const update = vi.fn().mockResolvedValue({});
    const getOctokit = vi.fn().mockResolvedValue({ checks: { update } });
    const resolveInstallationId = vi.fn().mockResolvedValue(99);
    const pollFn = vi.fn().mockResolvedValue({ status: "completed", outputText: "" });

    const finished = await resumeStaleSandboxJobs({ getOctokit, resolveInstallationId, pollFn, dbInstance: db } as any);

    expect(resolveInstallationId).toHaveBeenCalledWith("o", "r");
    expect(getOctokit).toHaveBeenCalledWith(99);
    expect(finished).toBe(1);
    expect(row(db, "ix-legacy").installation_id).toBe(99);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 7, status: "completed" }));
  });

  it("marks the job orphaned when the installation cannot be resolved", async () => {
    const db = getDatabase(":memory:");
    legacyJob(db, "ix-orphan");
    const getOctokit = vi.fn();
    const warn = vi.fn();

    await resumeStaleSandboxJobs({
      getOctokit,
      resolveInstallationId: vi.fn().mockRejectedValue(new Error("404")),
      dbInstance: db,
      log: { info: vi.fn(), warn },
    } as any);

    expect(getOctokit).not.toHaveBeenCalled();
    expect(row(db, "ix-orphan").status).toBe("orphaned");
    expect(warn).toHaveBeenCalled();

    // Terminal: a later sweep does not pick it up again.
    db.prepare("UPDATE sandbox_jobs SET updated_at = 0 WHERE interaction_id = 'ix-orphan'").run();
    await resumeStaleSandboxJobs({ getOctokit, dbInstance: db } as any);
    expect(row(db, "ix-orphan").status).toBe("orphaned");
  });
});
