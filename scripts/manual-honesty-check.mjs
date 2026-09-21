/**
 * Manual honesty check (no live Vertex / GitHub).
 * Verifies SQLite findings save/load and sandbox poll→conclusion mapping.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dbMod = await import("../dist/services/db.js");
const sandboxMod = await import("../dist/services/sandbox-runner.js");
const aiMod = await import("../dist/services/ai.js");

const out = [];
function log(msg) {
  out.push(msg);
  console.log(msg);
}

log("=== hq-jr manual honesty check ===");
log(`node ${process.version}`);
log(`IST label: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Calcutta" })} IST`);

const db = dbMod.getDatabase(":memory:");

log("\n[1] SQLite review_findings save/load");
dbMod.saveReviewFindings(
  [
    {
      owner: "adi-IL",
      repo: "hq-jr",
      pullNumber: 1,
      headSha: "sha-old",
      path: "src/services/ai.ts",
      line: 42,
      side: "RIGHT",
      severity: "CRITICAL",
      title: "Race",
      body: "Double-spend on refresh",
    },
  ],
  db
);
const loaded = dbMod.getReviewFindingsForPull(
  { owner: "adi-IL", repo: "hq-jr", pullNumber: 1, excludeHeadSha: "sha-new" },
  db
);
log(`saved=1 loaded=${loaded.length} path=${loaded[0]?.path} title=${loaded[0]?.title}`);
if (loaded.length !== 1 || loaded[0].title !== "Race") {
  throw new Error("findings save/load failed");
}

log("\n[2] sandbox_jobs upsert");
dbMod.upsertSandboxJob(
  {
    interactionId: "ix-manual-1",
    checkRunId: 9001,
    owner: "adi-IL",
    repo: "hq-jr",
    pullNumber: 1,
    headSha: "sha-new",
    branch: "feat/x",
    verificationGoal: "repro race",
    probesJson: "[]",
    testCommand: "npm test",
    status: "running",
  },
  db
);
const job = dbMod.getSandboxJobByCheckRun(
  { owner: "adi-IL", repo: "hq-jr", checkRunId: 9001 },
  db
);
log(`job interaction=${job?.interactionId} cmd=${job?.testCommand}`);
if (!job || job.interactionId !== "ix-manual-1") throw new Error("sandbox job failed");

log("\n[3] extractSandboxVerdict + mapVerdictToConclusion");
const sample =
  '```json\n{"baselinePassed":true,"reproduced":true,"patchCured":false,"summary":"still broken","synthesizedTestCode":"expect(1).toBe(2)"}\n```';
const verdict = aiMod.extractSandboxVerdict(sample);
log(
  `verdict reproduced=${verdict?.reproduced} cured=${verdict?.patchCured} hasTest=${Boolean(verdict?.synthesizedTestCode)}`
);
const conclusionFail = sandboxMod.mapVerdictToConclusion({ status: "completed", verdict });
const conclusionOk = sandboxMod.mapVerdictToConclusion({
  status: "completed",
  verdict: { reproduced: false, baselinePassed: true },
});
const conclusionTo = sandboxMod.mapVerdictToConclusion({ status: "timed_out", verdict: null });
log(`conclusion(reproduced uncured)=${conclusionFail}`);
log(`conclusion(not reproduced)=${conclusionOk}`);
log(`conclusion(timeout)=${conclusionTo}`);
if (conclusionFail !== "failure" || conclusionOk !== "success" || conclusionTo !== "neutral") {
  throw new Error("verdict mapping mismatch");
}

log("\n[4] executeSandboxCheckRun with mocked dispatch+poll");
const updates = [];
const octokit = {
  checks: {
    create: async () => ({ data: { id: 777 } }),
    update: async (p) => {
      updates.push({ status: p.status, conclusion: p.conclusion ?? null });
      return {};
    },
  },
};

const result = await sandboxMod.executeSandboxCheckRun({
  octokit,
  owner: "adi-IL",
  repo: "hq-jr",
  pullNumber: 1,
  headSha: "deadbeef",
  branch: "feat/x",
  verificationGoal: "manual",
  modifiedFiles: ["package.json"],
  dispatchFn: async () => "ix-mocked-manual",
  pollFn: async () => ({
    status: "completed",
    interactionStatus: "completed",
    verdict: {
      reproduced: true,
      patchCured: true,
      summary: "cured",
      synthesizedTestCode: "it('repro', () => {})",
      testFilePath: "tests/repro.test.ts",
    },
  }),
  dbInstance: db,
});

log(`result status=${result.status} conclusion=${result.conclusion}`);
log(`updates=${JSON.stringify(updates)}`);
if (updates[0]?.status !== "in_progress" || updates[0]?.conclusion !== null) {
  throw new Error("first update must stay in_progress without conclusion (no success-on-dispatch)");
}
if (updates.at(-1)?.status !== "completed" || updates.at(-1)?.conclusion !== "success") {
  throw new Error("final update must complete with poll conclusion");
}
if (!result.summary.includes("it('repro'")) {
  throw new Error("synthesized test missing from summary");
}
log("poll path OK: not success-on-dispatch; conclusion from poll");

db.close();
log("\n=== DONE ok ===");

const outPath = fileURLToPath(new URL("../manual-test-output.txt", import.meta.url));
writeFileSync(outPath, out.join("\n") + "\n");
