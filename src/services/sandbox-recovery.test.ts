import { describe, it, expect, vi } from "vitest";
import { resumeStaleSandboxJobs, executeSandboxCheckRun } from "./sandbox-runner.js";
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

function staleJob(db: import("better-sqlite3").Database, id: string) {
  upsertSandboxJob(
    { interactionId: id, checkRunId: 8, owner: "o", repo: "r", pullNumber: 1, headSha: "abc", status: "running", installationId: 5 },
    db
  );
  db.prepare("UPDATE sandbox_jobs SET updated_at = ? WHERE interaction_id = ?").run(Date.now() - 120_000, id);
}

describe("resumeStaleSandboxJobs failure paths", () => {
  it("closes the check as neutral and marks the job failed when the poll throws", async () => {
    const db = getDatabase(":memory:");
    staleJob(db, "ix-throw");
    const update = vi.fn().mockResolvedValue({});
    const pollFn = vi.fn().mockRejectedValue(new Error("boom"));

    await resumeStaleSandboxJobs({ getOctokit: vi.fn().mockResolvedValue({ checks: { update } }), pollFn, dbInstance: db } as any);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 8, status: "completed", conclusion: "neutral" }));
    expect(row(db, "ix-throw").status).toBe("failed");
  });

  it("leaves the job running when closing the check also fails", async () => {
    const db = getDatabase(":memory:");
    staleJob(db, "ix-close-fail");
    const update = vi.fn().mockRejectedValue(new Error("502"));
    const pollFn = vi.fn().mockRejectedValue(new Error("boom"));

    await resumeStaleSandboxJobs({ getOctokit: vi.fn().mockResolvedValue({ checks: { update } }), pollFn, dbInstance: db } as any);

    expect(update).toHaveBeenCalled();
    expect(row(db, "ix-close-fail").status).toBe("running");
  });

  it("does not overwrite the job or close the check after another worker reclaims the lease", async () => {
    const db = getDatabase(":memory:");
    staleJob(db, "ix-stolen");
    const update = vi.fn().mockResolvedValue({});
    const pollFn = vi.fn().mockImplementation(async () => {
      // A second worker reclaims the stalled lease mid-poll.
      db.prepare("UPDATE sandbox_jobs SET lease_token = 'other', status = 'recovering' WHERE interaction_id = 'ix-stolen'").run();
      return { status: "completed", outputText: "" };
    });

    const finished = await resumeStaleSandboxJobs({
      getOctokit: vi.fn().mockResolvedValue({ checks: { update } }),
      pollFn,
      dbInstance: db,
    } as any);

    expect(finished).toBe(1);
    expect(update).not.toHaveBeenCalled();
    const r = db.prepare("SELECT status, lease_token FROM sandbox_jobs WHERE interaction_id = 'ix-stolen'").get() as any;
    expect(r).toEqual({ status: "recovering", lease_token: "other" });
  });
});

describe("resumeStaleSandboxJobs lease loss during poll", () => {
  it("aborts the poll at the next heartbeat once the lease is reclaimed", async () => {
    const db = getDatabase(":memory:");
    staleJob(db, "ix-abort");
    const update = vi.fn().mockResolvedValue({});
    let sleeps = 0;
    const pollFn = vi.fn().mockImplementation(async (_id: string, opts: { sleep: (ms: number) => Promise<void> }) => {
      for (let i = 0; i < 10; i++) {
        if (i === 1) {
          db.prepare("UPDATE sandbox_jobs SET lease_token = 'other' WHERE interaction_id = 'ix-abort'").run();
        }
        await opts.sleep(0);
        sleeps += 1;
      }
      return { status: "completed", outputText: "" };
    });

    await resumeStaleSandboxJobs({
      getOctokit: vi.fn().mockResolvedValue({ checks: { update } }),
      pollFn,
      pollOptions: { sleep: async () => {} },
      dbInstance: db,
    } as any);

    expect(sleeps).toBe(1);
    expect(update).not.toHaveBeenCalled();
    const r = db.prepare("SELECT lease_token FROM sandbox_jobs WHERE interaction_id = 'ix-abort'").get() as any;
    expect(r.lease_token).toBe("other");
  });
});

describe("executeSandboxCheckRun after recovery claims the job", () => {
  function run(db: import("better-sqlite3").Database, pollFn: any, update = vi.fn().mockResolvedValue({})) {
    const octokit = { checks: { create: vi.fn().mockResolvedValue({ data: { id: 31 } }), update } };
    const done = executeSandboxCheckRun({
      octokit,
      owner: "o",
      repo: "r",
      pullNumber: 1,
      headSha: "sha",
      branch: "main",
      verificationGoal: "repro",
      dispatchFn: vi.fn().mockResolvedValue("ix-orig"),
      pollFn,
      pollOptions: { sleep: async () => {} },
      dbInstance: db,
    } as any);
    return { done, update };
  }
  const completedCalls = (update: any) => update.mock.calls.filter(([a]: any[]) => a.status === "completed");
  const status = (db: any) => (db.prepare("SELECT status FROM sandbox_jobs WHERE interaction_id = 'ix-orig'").get() as any).status;

  it("stops polling and leaves the check alone once recovery holds the job", async () => {
    const db = getDatabase(":memory:");
    let sleeps = 0;
    const pollFn = vi.fn().mockImplementation(async (_id: string, opts: any) => {
      db.prepare("UPDATE sandbox_jobs SET status = 'recovering', lease_token = 'rec' WHERE interaction_id = 'ix-orig'").run();
      await opts.sleep(0);
      sleeps += 1;
      return { status: "completed", outputText: "" };
    });
    const { done, update } = run(db, pollFn);
    const result = await done;

    expect(sleeps).toBe(0);
    expect(result.status).toBe("failed");
    expect(completedCalls(update)).toEqual([]);
    expect(status(db)).toBe("recovering");
  });

  it("does not overwrite a status recovery already finished", async () => {
    const db = getDatabase(":memory:");
    const pollFn = vi.fn().mockImplementation(async () => {
      db.prepare("UPDATE sandbox_jobs SET status = 'failure', lease_token = NULL WHERE interaction_id = 'ix-orig'").run();
      return { status: "completed", outputText: "" };
    });
    const { done, update } = run(db, pollFn);
    await done;

    expect(completedCalls(update)).toEqual([]);
    expect(status(db)).toBe("failure");
  });

  it("finishes normally when nobody else claimed the job", async () => {
    const db = getDatabase(":memory:");
    const { done, update } = run(db, vi.fn().mockImplementation(async (_id: string, opts: any) => {
      await opts.sleep(0);
      return { status: "completed", outputText: "" };
    }));
    await done;

    expect(completedCalls(update)).toHaveLength(1);
    expect(completedCalls(update)[0][0].conclusion).toBe("neutral");
    expect(status(db)).toBe("neutral");
  });
});

describe("executeSandboxCheckRun ownership check errors", () => {
  it("keeps the verdict when the post-poll ownership check throws", async () => {
    const db = getDatabase(":memory:");
    const update = vi.fn().mockResolvedValue({});
    const octokit = { checks: { create: vi.fn().mockResolvedValue({ data: { id: 32 } }), update } };
    const pollFn = vi.fn().mockImplementation(async () => {
      // Break the table so the post-poll heartbeat throws.
      db.exec("DROP TABLE sandbox_jobs");
      return { status: "completed", verdict: { reproduced: true, patchCured: true, summary: "cured" } };
    });

    const result = await executeSandboxCheckRun({
      octokit,
      owner: "o",
      repo: "r",
      pullNumber: 1,
      headSha: "sha",
      branch: "main",
      verificationGoal: "repro",
      dispatchFn: vi.fn().mockResolvedValue("ix-dberr"),
      pollFn,
      dbInstance: db,
    } as any);

    expect(result.conclusion).toBe("success");
    const final = update.mock.calls.map(([a]: any[]) => a).filter((a: any) => a.status === "completed");
    expect(final).toHaveLength(1);
    expect(final[0].conclusion).toBe("success");
  });

  it("defaults an upserted job to running so heartbeats land", () => {
    const db = getDatabase(":memory:");
    upsertSandboxJob({ interactionId: "ix-default", checkRunId: 1, owner: "o", repo: "r", pullNumber: 1, headSha: "s" }, db);
    expect((db.prepare("SELECT status FROM sandbox_jobs WHERE interaction_id = 'ix-default'").get() as any).status).toBe("running");
  });
});
