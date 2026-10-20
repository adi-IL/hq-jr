import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import appFn, { buildDeepReviewBody, buildExcludedFilesSummary, buildNoCodeChangesSummary } from "./index.js";
import { addRemediationCommit, acquireRunLock, releaseRunLock } from "./services/db.js";
import { BUDGET_DROP_REASON } from "./services/context-packager.js";
import * as aiModule from "./services/ai.js";
import * as sandboxRunnerModule from "./services/sandbox-runner.js";
import * as discussionModule from "./services/discussion.js";
import { formatDeepReviewPendingLine, runCliDeepReview, isCliEntryPoint } from "./cli.js";
import { config } from "./config.js";

describe("hq-jr Event Handlers & Security Guards", () => {
  let handlers: Map<string, Function>;
  let mockApp: any;
  let octokitMock: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    handlers = new Map();
    mockApp = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      on: vi.fn((eventOrEvents: string | string[], handler: Function) => {
        if (Array.isArray(eventOrEvents)) {
          for (const ev of eventOrEvents) {
            handlers.set(ev, handler);
          }
        } else {
          handlers.set(eventOrEvents, handler);
        }
      }),
    };

    octokitMock = {
      checks: {
        create: vi.fn().mockResolvedValue({ data: { id: 101 } }),
        update: vi.fn().mockResolvedValue({ data: { id: 101 } }),
      },
      pulls: {
        get: vi.fn(),
        createReview: vi.fn().mockResolvedValue({ data: { id: 201 } }),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
        listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        createReplyForReviewComment: vi.fn().mockResolvedValue({ data: { id: 301 } }),
        merge: vi.fn().mockResolvedValue({}),
      },
      repos: {
        getCollaboratorPermissionLevel: vi.fn(),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 401 } }),
        update: vi.fn().mockResolvedValue({}),
      },
      git: {
        createBlob: vi.fn().mockResolvedValue({ data: { sha: "blob-sha-123" } }),
        getCommit: vi.fn().mockResolvedValue({ data: { tree: { sha: "tree-sha-123" } } }),
        createTree: vi.fn().mockResolvedValue({ data: { sha: "new-tree-sha-123" } }),
        createCommit: vi.fn().mockResolvedValue({ data: { sha: "new-commit-sha-123" } }),
        updateRef: vi.fn().mockResolvedValue({}),
      },
    };

    appFn(mockApp);
  });

  const reviewCommentEvent = (comment: Record<string, unknown>) => ({
    octokit: octokitMock,
    payload: {
      action: "created",
      repository: { name: "test-repo", owner: { login: "test-owner" } },
      pull_request: { number: 6 },
      comment: { path: "src/index.ts", diff_hunk: "@@ -1,2 +1,2 @@", ...comment },
    },
  });

  const renameDiff = (count: number, path: (index: number) => string) =>
    Array.from({ length: count }, (_, index) => {
      const oldPath = path(index);
      const newPath = oldPath.replace("src/", "moved/");
      return `diff --git a/${oldPath} b/${newPath}\nsimilarity index 100%\nrename from ${oldPath}\nrename to ${newPath}\n`;
    }).join("");

  const ignoredFileDiff = (count: number, path: (index: number) => string) =>
    Array.from({ length: count }, (_, index) => {
      const filePath = path(index);
      return `diff --git a/${filePath} b/${filePath}\nindex 123..456 100644\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,1 +1,2 @@\n+# generated\n`;
    }).join("");

  it("does not reply to unmentioned human root review comments", async () => {
    const replySpy = vi.spyOn(discussionModule, "replyToDiscussion").mockResolvedValue("ack");

    await handlers.get("pull_request_review_comment.created")!(
      reviewCommentEvent({ id: 40, body: "Just leaving a note.", user: { login: "adi-IL", type: "User" } })
    );

    expect(replySpy).not.toHaveBeenCalled();
    expect(octokitMock.pulls.createReplyForReviewComment).not.toHaveBeenCalled();
    expect(octokitMock.pulls.listReviewComments).not.toHaveBeenCalled();
  });

  it("does not reply in threads started by another bot", async () => {
    octokitMock.pulls.listReviewComments.mockResolvedValueOnce({
      data: [
        { id: 20, user: { login: "greptile-apps[bot]", type: "Bot" }, body: "P1: retry is skipped", created_at: "2026-10-18T10:00:00Z" },
        { id: 21, in_reply_to_id: 20, user: { login: "hq-jr[bot]", type: "Bot" }, body: "Agreed.", created_at: "2026-10-18T10:01:00Z" },
        { id: 22, in_reply_to_id: 20, user: { login: "adi-IL", type: "User" }, body: "Fixed in the next push.", created_at: "2026-10-18T10:05:00Z" },
      ],
    });
    const replySpy = vi.spyOn(discussionModule, "replyToDiscussion").mockResolvedValue("ack");

    await handlers.get("pull_request_review_comment.created")!(
      reviewCommentEvent({ id: 22, in_reply_to_id: 20, body: "Fixed in the next push.", user: { login: "adi-IL", type: "User" } })
    );

    expect(replySpy).not.toHaveBeenCalled();
    expect(octokitMock.pulls.createReplyForReviewComment).not.toHaveBeenCalled();
  });

  it("replies in threads hq-jr started", async () => {
    octokitMock.pulls.listReviewComments.mockResolvedValueOnce({
      data: [
        { id: 30, user: { login: "hq-jr[bot]", type: "Bot" }, body: "### [BUG] Missing await", created_at: "2026-10-18T10:00:00Z" },
        { id: 31, in_reply_to_id: 30, user: { login: "adi-IL", type: "User" }, body: "Why is it needed?", created_at: "2026-10-18T10:05:00Z" },
      ],
    });
    vi.spyOn(discussionModule, "replyToDiscussion").mockResolvedValue("Because the promise rejects unobserved.");

    await handlers.get("pull_request_review_comment.created")!(
      reviewCommentEvent({ id: 31, in_reply_to_id: 30, body: "Why is it needed?", user: { login: "adi-IL", type: "User" } })
    );

    expect(octokitMock.pulls.createReplyForReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 31, body: "Because the promise rejects unobserved." })
    );
  });

  it("reports a neutral check when the deep review hits a network failure", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Large change",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    const deepSpy = vi
      .spyOn(aiModule, "runDeepReview")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue({
        summary: "ok",
        verdict: "COMMENT",
        resolvedPriorIssues: [],
        unresolvedPriorIssues: [],
        comments: [],
        requiresSandboxVerification: false,
        sandboxProbes: [],
      });
    const diff = `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`;
    octokitMock.pulls.get.mockResolvedValueOnce({ data: diff });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 6, state: "open", head: { sha: "sha-6", ref: "big" }, title: "Big PR" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate).toMatchObject({ status: "completed", conclusion: "neutral" });
    // The escalation attempt and its Tier 2 fallback consume both queued rejections.
    expect(deepSpy).toHaveBeenCalledTimes(2);

    // A later review run is served by the same spy and still completes.
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Later change",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({ data: diff });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 61, state: "open", head: { sha: "sha-61", ref: "later" }, title: "Later PR" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    expect(deepSpy).toHaveBeenCalledTimes(3);
    expect(octokitMock.checks.update.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
    });
  });

  it("still fails the check when the review requests changes", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth change",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "Login logs credentials",
      verdict: "REQUEST_CHANGES",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [
        { path: "src/auth.ts", line: 2, side: "RIGHT", severity: "CRITICAL", category: "SECURITY", title: "Logs in login path", body: "Remove the log." },
      ],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 8, state: "open", head: { sha: "sha-8", ref: "c" }, title: "PR" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    expect(octokitMock.checks.update.mock.calls.at(-1)?.[0]).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("keeps the check run neutral when a REQUEST_CHANGES review reports no comments", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth change",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "The review found no issues.",
      verdict: "REQUEST_CHANGES",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 81, state: "open", head: { sha: "sha-81", ref: "c" }, title: "PR" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(finalUpdate.output.title).toBe("Review Completed: COMMENT");
    expect(finalUpdate.output.summary).toContain("Found **0** observation(s).");
    expect(mockApp.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "REQUEST_CHANGES", effectiveVerdict: "COMMENT" }),
      expect.stringContaining("REQUEST_CHANGES")
    );
  });

  it("still fails the check when a REQUEST_CHANGES review reports a comment", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth change",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "One blocker.",
      verdict: "REQUEST_CHANGES",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [
        { path: "src/auth.ts", line: 2, side: "RIGHT", severity: "CRITICAL", category: "SECURITY", title: "Logs a credential", body: "Remove the log." },
      ],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 82, state: "open", head: { sha: "sha-82", ref: "c" }, title: "PR" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    expect(octokitMock.checks.update.mock.calls.at(-1)?.[0]).toMatchObject({ status: "completed", conclusion: "failure" });
    const reviewCall = octokitMock.pulls.createReview.mock.calls.at(-1)?.[0];
    expect(reviewCall.event).toBe("REQUEST_CHANGES");
    expect(reviewCall.body).toContain("**Verdict:** `REQUEST_CHANGES`");
    expect(reviewCall.body).toContain("Found **1** observation(s).");
  });

  const authDiff = `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`;

  const openAuthPr = (number: number) =>
    handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number, state: "open", head: { sha: `sha-${number}`, ref: "c" }, title: "PR" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

  it("downgrades REQUEST_CHANGES after a false missing-ref comment is dropped and logs it", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth change",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "actions/checkout@v7 does not exist.",
      verdict: "REQUEST_CHANGES",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [
        {
          path: "src/auth.ts",
          line: 2,
          side: "RIGHT",
          severity: "WARNING",
          category: "BUG",
          title: "Missing action",
          body: "actions/checkout@v7 does not exist.",
        },
      ],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.git.getRef = vi.fn().mockResolvedValue({ data: { ref: "refs/tags/v7" } });
    octokitMock.pulls.get.mockResolvedValueOnce({ data: authDiff });

    await openAuthPr(83);

    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(finalUpdate.output.title).toBe("Review Completed: COMMENT");
    expect(mockApp.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "REQUEST_CHANGES", effectiveVerdict: "COMMENT" }),
      expect.stringContaining("REQUEST_CHANGES")
    );
  });

  it("fails the check when REQUEST_CHANGES has an unresolved prior issue and no comments", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth change",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "The loop bound is still wrong.",
      verdict: "REQUEST_CHANGES",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: ["The loop bound is still wrong."],
      comments: [],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({ data: authDiff });

    await openAuthPr(84);

    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(finalUpdate.output.title).toBe("Review Completed: REQUEST_CHANGES");
    expect(mockApp.log.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ effectiveVerdict: "COMMENT" }),
      expect.any(String)
    );
  });

  it("fails the check when APPROVE reports a blocking comment", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth change",
      overallRisk: "LOW",
      files: [{ path: "src/auth.ts", risk: "LOW", reason: "Auth", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "A warning remains.",
      verdict: "APPROVE",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [
        {
          path: "src/auth.ts",
          line: 2,
          side: "RIGHT",
          severity: "WARNING",
          category: "BUG",
          title: "Off by one",
          body: "Fix the bound.",
        },
      ],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({ data: authDiff });

    await openAuthPr(85);

    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(finalUpdate.output.title).toBe("Review Completed: REQUEST_CHANGES");
    expect(mockApp.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "APPROVE", effectiveVerdict: "REQUEST_CHANGES" }),
      expect.stringContaining("REQUEST_CHANGES")
    );
  });

  it("keeps the check successful when APPROVE reports only suggestions", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth change",
      overallRisk: "LOW",
      files: [{ path: "src/auth.ts", risk: "LOW", reason: "Auth", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "One suggestion.",
      verdict: "APPROVE",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [
        {
          path: "src/auth.ts",
          line: 2,
          side: "RIGHT",
          severity: "SUGGESTION",
          category: "STYLE",
          title: "Name the flag",
          body: "A clearer name would help.",
        },
      ],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({ data: authDiff });

    await openAuthPr(86);

    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate).toMatchObject({ status: "completed", conclusion: "success" });
    expect(finalUpdate.output.title).toBe("Review Completed: APPROVE");
  });

  it("escalates the deep review to the escalation model on high risk pull requests", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth rewrite",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    const deepSpy = vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "ok",
      verdict: "COMMENT",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 21, state: "open", head: { sha: "sha-21", ref: "risk" }, title: "Auth rewrite" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    const deepOptions = deepSpy.mock.calls[0][1] as { model?: string } | undefined;
    expect(deepOptions?.model).toBeTruthy();
    expect(deepOptions?.model).toBe(config.HQ_JR_MODEL_ESCALATION);
    expect(deepOptions?.model).not.toBe(config.HQ_JR_MODEL_TIER2);
  });

  it("keeps the deep review on the Tier 2 model below the escalation threshold", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Docs tweak",
      overallRisk: "MEDIUM",
      files: [{ path: "src/auth.ts", risk: "MEDIUM", reason: "Docs", shouldReview: true }],
    });
    const deepSpy = vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "ok",
      verdict: "COMMENT",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 22, state: "open", head: { sha: "sha-22", ref: "calm" }, title: "Docs tweak" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    expect(deepSpy.mock.calls[0][1]?.model).toBe(config.HQ_JR_MODEL_TIER2);
  });

  it("retries the deep review on the Tier 2 model when the escalation model fails", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth rewrite",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    const deepSpy = vi
      .spyOn(aiModule, "runDeepReview")
      .mockRejectedValueOnce(new Error("model gemini-4-argon is not accessible in this project"))
      .mockResolvedValueOnce({
        summary: "ok",
        verdict: "COMMENT",
        resolvedPriorIssues: [],
        unresolvedPriorIssues: [],
        comments: [],
        requiresSandboxVerification: false,
        sandboxProbes: [],
      });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 23, state: "open", head: { sha: "sha-23", ref: "fallback" }, title: "Auth rewrite" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    expect(deepSpy).toHaveBeenCalledTimes(2);
    expect(deepSpy.mock.calls[0][1]?.model).toBeTruthy();
    expect(deepSpy.mock.calls[0][1]?.model).toBe(config.HQ_JR_MODEL_ESCALATION);
    expect(deepSpy.mock.calls[1][1]?.model).toBe(config.HQ_JR_MODEL_TIER2);
    expect(mockApp.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        escalationModel: config.HQ_JR_MODEL_ESCALATION,
        fallbackModel: config.HQ_JR_MODEL_TIER2,
      }),
      expect.stringContaining("retrying deep review on the Tier 2 model")
    );
    expect(octokitMock.checks.update.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
    });
  });

  it("surfaces renamed files in the no code changes summary", async () => {
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/old/auth.ts b/src/new/auth.ts
similarity index 100%
rename from src/old/auth.ts
rename to src/new/auth.ts
`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        action: "opened",
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        pull_request: {
          number: 24,
          state: "open",
          title: "Move auth module",
          head: { sha: "sha-24", ref: "rename" },
          user: { login: "alice" },
        },
        sender: { login: "alice", type: "User" },
      },
    });

    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(finalUpdate.output.summary).toContain("src/old/auth.ts");
    expect(finalUpdate.output.summary).toContain("src/new/auth.ts");
  });

  it("escapes backticks in renamed file paths in the check summary", async () => {
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: "diff --git a/src/old`x.ts b/src/new`x.ts\nsimilarity index 100%\nrename from src/old`x.ts\nrename to src/new`x.ts\n",
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        action: "opened",
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        pull_request: {
          number: 25,
          state: "open",
          title: "Move auth module",
          head: { sha: "sha-25", ref: "rename" },
          user: { login: "alice" },
        },
        sender: { login: "alice", type: "User" },
      },
    });

    // A longer fence keeps the real path text; an entity like &#96; would render literally in a code span.
    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate.output.summary).toContain("- ``src/old`x.ts`` -> ``src/new`x.ts``");
    expect(finalUpdate.output.summary).not.toContain("&#96;");
  });

  it("caps the renamed file list in the no code changes summary", async () => {
    octokitMock.pulls.get.mockResolvedValueOnce({ data: renameDiff(312, (index) => `src/old/file${index}.ts`) });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        action: "opened",
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        pull_request: {
          number: 26,
          state: "open",
          title: "Move the whole folder",
          head: { sha: "sha-26", ref: "rename" },
          user: { login: "alice" },
        },
        sender: { login: "alice", type: "User" },
      },
    });

    const summary = octokitMock.checks.update.mock.calls.at(-1)?.[0].output.summary as string;
    expect(summary.length).toBeLessThan(65535);
    expect(summary).toContain("Renamed files (showing first 50 of 312):");
  });

  it("keeps the no code changes summary under the check character limit with long paths", async () => {
    const longPath = (index: number) => `src/${"d".repeat(3000)}/file${index}.ts`;
    octokitMock.pulls.get.mockResolvedValueOnce({ data: renameDiff(312, longPath) });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        action: "opened",
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        pull_request: {
          number: 27,
          state: "open",
          title: "Move the whole folder",
          head: { sha: "sha-27", ref: "rename" },
          user: { login: "alice" },
        },
        sender: { login: "alice", type: "User" },
      },
    });

    const summary = octokitMock.checks.update.mock.calls.at(-1)?.[0].output.summary as string;
    expect(summary.length).toBeLessThan(65535);
    expect(summary).toMatch(/Renamed files \(showing first \d+ of 312\):/);
  });

  it("caps the excluded file list in the excluded files only summary", async () => {
    octokitMock.pulls.get.mockResolvedValueOnce({ data: ignoredFileDiff(2000, (index) => `docs/guide${index}.md`) });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        action: "opened",
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        pull_request: {
          number: 28,
          state: "open",
          title: "Regenerate every doc",
          head: { sha: "sha-28", ref: "docs" },
          user: { login: "alice" },
        },
        sender: { login: "alice", type: "User" },
      },
    });

    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate.output.title).toBe("Triage Passed: Excluded Files Only");
    const summary = finalUpdate.output.summary as string;
    expect(summary.length).toBeLessThan(65535);
    expect(summary).toContain("Modified files were excluded from review");
    expect(summary).toContain("Excluded files (showing first 50 of 2000):");
  });

  it("keeps the excluded files only summary under the check character limit with long paths", async () => {
    const longPath = (index: number) => `docs/${"d".repeat(3000)}/page${index}.md`;
    octokitMock.pulls.get.mockResolvedValueOnce({ data: ignoredFileDiff(200, longPath) });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        action: "opened",
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        pull_request: {
          number: 29,
          state: "open",
          title: "Regenerate every doc",
          head: { sha: "sha-29", ref: "docs" },
          user: { login: "alice" },
        },
        sender: { login: "alice", type: "User" },
      },
    });

    const summary = octokitMock.checks.update.mock.calls.at(-1)?.[0].output.summary as string;
    expect(summary.length).toBeLessThan(65535);
    expect(summary).toContain("...[truncated]");
    expect(summary).toMatch(/Excluded files \(showing first \d+ of 200\):/);
  });

  it("caps the model summary in the low risk check summary", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "verbose model answer ".repeat(12000),
      overallRisk: "LOW",
      files: [{ path: "src/config.ts", risk: "LOW", reason: "Config only", shouldReview: false }],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/config.ts b/src/config.ts
index 123..456 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,3 +1,4 @@
 export const port = 3000;
+export const host = "localhost";
`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        action: "opened",
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        pull_request: {
          number: 30,
          state: "open",
          title: "Config tweak",
          head: { sha: "sha-30", ref: "config" },
          user: { login: "alice" },
        },
        sender: { login: "alice", type: "User" },
      },
    });

    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate.output.title).toBe("Triage Passed: Low Risk Changes");
    const summary = finalUpdate.output.summary as string;
    expect(summary.length).toBeLessThan(65535);
    expect(summary).toContain("All modified files are low risk or auto-generated. Deep review bypassed.");
    expect(summary).toContain("truncated");
  });

  it("caps the model summary in the deep review check summary", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth change",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "verbose model answer ".repeat(12000),
      verdict: "COMMENT",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        action: "opened",
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        pull_request: {
          number: 32,
          state: "open",
          title: "Auth change",
          head: { sha: "sha-32", ref: "auth" },
          user: { login: "alice" },
        },
        sender: { login: "alice", type: "User" },
      },
    });

    const finalUpdate = octokitMock.checks.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate.output.title).toBe("Review Completed: COMMENT");
    const summary = finalUpdate.output.summary as string;
    expect(summary.length).toBeLessThan(65535);
    expect(summary).toContain("Found **0** observation(s).");
    expect(summary).toContain("truncated");
  });

  it("does not describe a file dropped for the context budget as an artifact", () => {
    const summary = buildExcludedFilesSummary([
      { path: "src/big.ts", reason: BUDGET_DROP_REASON },
    ]);

    expect(summary).toContain("src/big.ts");
    expect(summary).toContain(BUDGET_DROP_REASON);
    // A file that was dropped for the budget was not a lockfile and not a
    // generated bundle.
    expect(summary.toLowerCase()).not.toContain("lockfile");
    expect(summary.toLowerCase()).not.toContain("generated bundle");
  });

  it("keeps the artifact reasons in the excluded files summary", () => {
    const summary = buildExcludedFilesSummary([
      { path: "package-lock.json", reason: "Dependency lockfile: package-lock.json" },
      { path: "src/big.ts", reason: BUDGET_DROP_REASON },
    ]);

    expect(summary).toContain("package-lock.json");
    expect(summary).toContain("Dependency lockfile: package-lock.json");
    expect(summary).toContain(BUDGET_DROP_REASON);
  });

  it("scrubs credentials from paths in file summaries", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const path = `src/API_KEY=${token}`;
    const excluded = buildExcludedFilesSummary([{ path, reason: "Ignored" }]);
    const renamed = buildNoCodeChangesSummary([{ oldPath: path, newPath: path }]);

    expect(excluded).toContain("src/API_KEY=[REDACTED_SECRET]");
    expect(renamed).toContain("src/API_KEY=[REDACTED_SECRET]");
    expect(excluded).not.toContain(token);
    expect(renamed).not.toContain(token);
  });

  it("still fails the check when the review itself errors", async () => {
    vi.spyOn(aiModule, "runTriage").mockRejectedValueOnce(new Error("Triage response failed schema validation"));
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 7, state: "open", head: { sha: "sha-7", ref: "b" }, title: "PR" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    expect(octokitMock.checks.update.mock.calls.at(-1)?.[0]).toMatchObject({ conclusion: "failure" });
  });

  it("handles 0-hunk PRs neutrally without calling AI deep review", async () => {
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/binary.png b/binary.png
new file mode 100644
index 0000000..1234567
Binary files /dev/null and b/binary.png differ`,
    });

    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    await handler!({
      octokit: octokitMock,
      payload: {
        action: "opened",
        repository: {
          name: "test-repo",
          owner: { login: "test-owner" },
        },
        pull_request: {
          number: 42,
          state: "open",
          title: "Add assets",
          head: { sha: "abc1234567890" },
          user: { login: "alice" },
        },
        sender: {
          login: "alice",
          type: "User",
        },
      },
    });

    expect(octokitMock.checks.create).toHaveBeenCalled();
    expect(octokitMock.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "neutral",
        status: "completed",
      })
    );
  });

  it("denies remediation commands from non-collaborators with access denied notice", async () => {
    octokitMock.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: "read" },
    });

    const handler = handlers.get("issue_comment.created");
    expect(handler).toBeDefined();

    await handler!({
      octokit: octokitMock,
      payload: {
        action: "created",
        repository: {
          name: "test-repo",
          owner: { login: "test-owner" },
        },
        issue: {
          number: 42,
          pull_request: {},
        },
        comment: {
          body: "@hq-jr fix and merge",
          user: { login: "untrusted-user", type: "User" },
        },
      },
    });

    expect(octokitMock.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Access Denied"),
      })
    );
  });

  it("does not hijack human-to-human discussion comments when @hq-jr is not mentioned", async () => {
    octokitMock.pulls.listReviewComments.mockResolvedValueOnce({
      data: [
        { id: 10, user: { login: "developer-a", type: "User" }, body: "Is this correct?", created_at: "2026-09-17T10:00:00Z" },
        { id: 11, in_reply_to_id: 10, user: { login: "developer-b", type: "User" }, body: "Yes, verified.", created_at: "2026-09-17T10:05:00Z" }
      ],
    });

    const handler = handlers.get("pull_request_review_comment.created");
    expect(handler).toBeDefined();

    await handler!({
      octokit: octokitMock,
      payload: {
        action: "created",
        repository: {
          name: "test-repo",
          owner: { login: "test-owner" },
        },
        pull_request: {
          number: 42,
        },
        comment: {
          id: 11,
          in_reply_to_id: 10,
          path: "src/index.ts",
          diff_hunk: "@@ -1,2 +1,2 @@",
          body: "Yes, verified.",
          user: { login: "developer-b", type: "User" },
        },
      },
    });

    // Should NOT call createReplyForReviewComment
    expect(octokitMock.pulls.createReplyForReviewComment).not.toHaveBeenCalled();
  });

  it("ignores pull request events triggered for remediation commit SHAs stored in SQLite", async () => {
    const remediationSha = "remediation-commit-sha-999";
    addRemediationCommit(remediationSha);

    const handler = handlers.get("pull_request.synchronize");
    expect(handler).toBeDefined();

    await handler!({
      octokit: octokitMock,
      payload: {
        pull_request: {
          number: 55,
          state: "open",
          head: { sha: remediationSha },
          title: "Automated fix",
        },
        repository: {
          name: "test-repo",
          owner: { login: "test-owner" },
        },
        sender: { login: "developer", type: "User" },
      },
    });

    expect(octokitMock.checks.create).not.toHaveBeenCalled();
    expect(mockApp.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ sha: remediationSha }),
      expect.stringContaining("remediation commit")
    );
  });

  it("skips duplicate concurrent review runs on the same pull request when locked in SQLite", async () => {
    const lockKey = "test-owner/test-repo#77";
    acquireRunLock({
      runKey: lockKey,
      owner: "test-owner",
      repo: "test-repo",
      pullNumber: 77,
      headSha: "initial-sha",
    });

    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    await handler!({
      octokit: octokitMock,
      payload: {
        pull_request: {
          number: 77,
          state: "open",
          head: { sha: "second-sha" },
          title: "PR under active review",
        },
        repository: {
          name: "test-repo",
          owner: { login: "test-owner" },
        },
        sender: { login: "developer", type: "User" },
      },
    });

    expect(octokitMock.checks.create).not.toHaveBeenCalled();
    expect(mockApp.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runKey: lockKey }),
      expect.stringContaining("Review run already active for pull request")
    );

    releaseRunLock(lockKey);
  });

  it("dispatches Tier 3 sandbox check run when deep review requires sandbox verification", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "High risk change",
      overallRisk: "HIGH",
      files: [
        {
          path: "src/auth.ts",
          risk: "HIGH",
          reason: "Auth state mutation",
          shouldReview: true,
        },
      ],
    });

    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "Found potential concurrency issue",
      verdict: "COMMENT",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [],
      requiresSandboxVerification: true,
      verificationGoal: "Verify concurrency race condition under load",
    });

    const sandboxSpy = vi
      .spyOn(sandboxRunnerModule, "executeSandboxCheckRun")
      .mockResolvedValueOnce({
        checkRunId: 789,
        interactionId: "interaction-test-456",
        status: "dispatched",
        summary: "Sandbox verification dispatched",
      });

    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    await handler!({
      octokit: octokitMock,
      payload: {
        pull_request: {
          number: 88,
          state: "open",
          head: { sha: "sha-88", ref: "auth-branch" },
          title: "Feature Auth",
        },
        repository: {
          name: "test-repo",
          owner: { login: "test-owner" },
        },
        sender: { login: "developer", type: "User" },
      },
    });

    expect(sandboxSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test-owner",
        repo: "test-repo",
        pullNumber: 88,
        headSha: "sha-88",
        branch: "auth-branch",
        verificationGoal: "Verify concurrency race condition under load",
      })
    );
  });

  it("does not post findings that claim an existing action tag is missing", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Workflow action bumps",
      overallRisk: "MEDIUM",
      files: [{ path: ".github/workflows/ci.yml", risk: "MEDIUM", reason: "CI change", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "Action versions look wrong",
      verdict: "REQUEST_CHANGES",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [
        {
          path: ".github/workflows/ci.yml",
          line: 35,
          side: "RIGHT",
          severity: "CRITICAL",
          category: "BUG",
          title: "Non-existent action version actions/checkout@v7",
          body: "The action actions/checkout@v7 does not exist; actions/checkout is currently on major version v4. The job will fail during action download.",
          suggestedPatch: "      - uses: actions/checkout@v4",
        },
      ],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    (octokitMock.git as any).getRef = vi.fn().mockResolvedValue({ data: { ref: "refs/tags/v7" } });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 123..456 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -32,7 +32,7 @@ jobs:
     runs-on: ubuntu-latest
     steps:
-      - uses: actions/checkout@v4
+      - uses: actions/checkout@v7
       - uses: dorny/paths-filter@v4
         id: filter
         with:`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 1, state: "open", head: { sha: "fd1a8d9", ref: "bump-actions-majors" }, title: "Bump actions" },
        repository: { name: "MidSphere", owner: { login: "adi-IL" } },
        sender: { login: "adi-IL", type: "User" },
      },
    });

    expect((octokitMock.git as any).getRef).toHaveBeenCalledWith({ owner: "actions", repo: "checkout", ref: "tags/v7" });
    const posted = JSON.stringify(octokitMock.pulls.createReview.mock.calls);
    expect(posted).not.toContain("Non-existent action version");
  });

  it("commits synthesized reproduction test when maintainer clicks Commit Repro Test action", async () => {
    octokitMock.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: "admin" },
    });

    // Handler + commitReproTestFromSummary each call pulls.get (fork check needs head.repo).
    octokitMock.pulls.get.mockResolvedValue({
      data: {
        head: {
          sha: "head-sha-111",
          ref: "fix/player-audio",
          repo: { full_name: "test-owner/test-repo" },
        },
      },
    });

    const handler = handlers.get("check_run.requested_action");
    expect(handler).toBeDefined();

    await handler!({
      octokit: octokitMock,
      payload: {
        action: "requested_action",
        requested_action: { identifier: "commit_repro_test" },
        check_run: {
          id: 555,
          pull_requests: [{ number: 15 }],
          output: {
            summary:
              "## Adversarial Repro\n### Synthesized Reproduction Test (tests/repro_audio.rs)\n\n```rust\n#[test]\nfn test_audio_desync() { assert!(true); }\n```",
          },
        },
        repository: {
          name: "test-repo",
          owner: { login: "test-owner" },
        },
        sender: { login: "lead-dev" },
      },
    });

    expect(octokitMock.git.createBlob).toHaveBeenCalled();
    expect(octokitMock.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        tree: [expect.objectContaining({ path: "tests/repro_audio.rs" })],
      })
    );
    expect(octokitMock.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("add synthesized adversarial reproduction test"),
      })
    );
    expect(octokitMock.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "heads/fix/player-audio",
      })
    );
    expect(octokitMock.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Reproduction Test Committed"),
      })
    );
  });

  it("refuses commit-repro on fork PR heads", async () => {
    octokitMock.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: "admin" },
    });
    octokitMock.pulls.get.mockResolvedValue({
      data: {
        head: {
          sha: "head-sha-fork",
          ref: "fork-branch",
          repo: { full_name: "other-user/test-repo" },
        },
      },
    });

    const handler = handlers.get("check_run.requested_action");
    await handler!({
      octokit: octokitMock,
      payload: {
        action: "requested_action",
        requested_action: { identifier: "commit_repro_test" },
        check_run: {
          id: 556,
          pull_requests: [{ number: 16 }],
          output: {
            summary:
              "### Synthesized Reproduction Test\n\n```typescript\nexpect(true).toBe(true);\n```",
          },
        },
        repository: {
          name: "test-repo",
          owner: { login: "test-owner" },
        },
        sender: { login: "lead-dev" },
      },
    });

    expect(octokitMock.git.updateRef).not.toHaveBeenCalled();
    expect(octokitMock.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("fork PR"),
      })
    );
  });

  it("handles standalone '@hq-jr close the issue and merge it' command by closing linked issue and merging PR", async () => {
    octokitMock.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: "admin" },
    });

    octokitMock.pulls.get.mockResolvedValueOnce({
      data: {
        number: 5,
        body: "Fixes reliability. Closes #4",
        head: { sha: "head-sha-555", ref: "fix/player-audio" },
      },
    });

    const handler = handlers.get("issue_comment.created");
    expect(handler).toBeDefined();

    await handler!({
      octokit: octokitMock,
      payload: {
        issue: { number: 5, pull_request: {} },
        comment: {
          id: 999,
          body: "@hq-jr close the issue and merge it",
          user: { login: "test-maintainer", type: "User" },
        },
        repository: {
          name: "test-repo",
          owner: { login: "test-owner" },
        },
      },
    });

    expect(octokitMock.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 4,
        state: "closed",
      })
    );
    expect(octokitMock.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 5,
        merge_method: "squash",
      })
    );
    expect(octokitMock.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Merged"),
      })
    );
  });

  it("caps a verbose deep review summary in the review body", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth rewrite",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "verbose model answer ".repeat(12000),
      verdict: "REQUEST_CHANGES",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [
        {
          path: "src/auth.ts",
          line: 2,
          side: "RIGHT",
          severity: "CRITICAL",
          category: "SECURITY",
          title: "Logs in login path",
          body: "Remove the log.",
        },
      ],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 90, state: "open", head: { sha: "sha-90", ref: "verbose" }, title: "Verbose review" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    const body = octokitMock.pulls.createReview.mock.calls[0][0].body as string;
    expect(body.length).toBeLessThan(65535);
    expect(body).toContain("## hq-jr Automated Code Review");
    expect(body).toContain("**Verdict:** `REQUEST_CHANGES`");
    expect(body).toContain("truncated");
  });

  it("caps the 422 fallback body that carries the inline comments", async () => {
    vi.spyOn(aiModule, "runTriage").mockResolvedValueOnce({
      summary: "Auth rewrite",
      overallRisk: "HIGH",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "Auth", shouldReview: true }],
    });
    vi.spyOn(aiModule, "runDeepReview").mockResolvedValueOnce({
      summary: "verbose model answer ".repeat(12000),
      verdict: "COMMENT",
      resolvedPriorIssues: [],
      unresolvedPriorIssues: [],
      comments: [
        {
          path: "src/auth.ts",
          line: 2,
          side: "RIGHT",
          severity: "CRITICAL",
          category: "SECURITY",
          title: "Logs in login path",
          body: "verbose inline body ".repeat(4000),
        },
      ],
      requiresSandboxVerification: false,
      sandboxProbes: [],
    });
    octokitMock.pulls.createReview
      .mockRejectedValueOnce(Object.assign(new Error("Validation Failed"), { status: 422 }))
      .mockResolvedValueOnce({ data: { id: 202 } });
    octokitMock.pulls.get.mockResolvedValueOnce({
      data: `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login() {
+  console.log("login");
   return true;
 }`,
    });

    await handlers.get("pull_request.opened")!({
      octokit: octokitMock,
      payload: {
        pull_request: { number: 91, state: "open", head: { sha: "sha-91", ref: "fallback" }, title: "Verbose review" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "developer", type: "User" },
      },
    });

    expect(octokitMock.pulls.createReview).toHaveBeenCalledTimes(2);
    const fallback = octokitMock.pulls.createReview.mock.calls[1][0].body as string;
    expect(fallback.length).toBeLessThan(65535);
    expect(fallback).toContain("## hq-jr Automated Code Review");
    expect(fallback).toContain("**Verdict:** `REQUEST_CHANGES`");
    expect(fallback).toContain("### Inline Comments (Attached as Summary due to diff positioning):");
    expect(fallback).toContain("truncated");
  });
});

describe("deep review body budget", () => {
  it("keeps the structure of the body and marks the cut", () => {
    const body = buildDeepReviewBody({
      summary: "verbose model answer ".repeat(12000),
      verdict: "REQUEST_CHANGES",
      commentCount: 1,
      resolvedPriorIssues: ["fixed the race"],
      unresolvedPriorIssues: ["the lock is still missing"],
      orphanComments: ["- **src/auth.ts:9** [WARNING]: note outside the diff"],
      inlineComments: [{ path: "src/auth.ts", line: 2, side: "RIGHT", body: "fix this" }],
    });

    expect(body.length).toBeLessThan(65535);
    expect(body).toContain("## hq-jr Automated Code Review");
    expect(body).toContain("**Verdict:** `REQUEST_CHANGES`");
    expect(body).toContain("Found **1** observation(s).");
    expect(body).toContain("### ✅ Resolved Issues from Prior Review");
    expect(body).toContain("### ⚠️ Remaining Open Issues from Prior Review");
    expect(body).toContain("### Additional File Observations (Outside Modified Diff Lines)");
    expect(body).toContain("### Inline Comments (Attached as Summary due to diff positioning):");
    expect(body).toContain("fixed the race");
    expect(body).toContain("the lock is still missing");
    expect(body).toContain("truncated");
  });

  it("leaves a short review body untouched", () => {
    expect(buildDeepReviewBody({ summary: "short", verdict: "APPROVE", commentCount: 0 })).toBe(
      "## hq-jr Automated Code Review\n\nshort\n\n**Verdict:** `APPROVE`\n\nFound **0** observation(s)."
    );
  });

  it("states the same count of findings that the check run reports", () => {
    const body = buildDeepReviewBody({
      summary: "two findings",
      verdict: "COMMENT",
      commentCount: 2,
    });

    expect(body).toContain("Found **2** observation(s).");
  });

  it("keeps a small body budget inside the cap and still marks the cut", () => {
    for (const maxChars of [20, 50, 80, 120, 200, 400]) {
      const body = buildDeepReviewBody({
        summary: "verbose model answer ".repeat(50),
        verdict: "REQUEST_CHANGES",
        commentCount: 1,
        resolvedPriorIssues: ["fixed the race"],
        unresolvedPriorIssues: ["the lock is still missing"],
        orphanComments: ["- **src/auth.ts:9** [WARNING]: note outside the diff"],
        inlineComments: [{ path: "src/auth.ts", line: 2, side: "RIGHT", body: "fix this" }],
        maxChars,
      });

      expect(body.length).toBeLessThanOrEqual(maxChars);
      // The cut is marked, so a reader can tell a cut review from a short one.
      expect(body).toMatch(/truncated|\.\.\.\[cut\]/);
    }
  });
});

describe("CLI deep review output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const deepReviewResult = {
    summary: "ok",
    verdict: "COMMENT" as const,
    resolvedPriorIssues: [],
    unresolvedPriorIssues: [],
    comments: [],
    requiresSandboxVerification: false,
    sandboxProbes: [],
  };

  it("names the model that is about to run before the deep review call", async () => {
    const order: string[] = [];
    vi.spyOn(aiModule, "runDeepReview").mockImplementation(async (_prompt, options) => {
      order.push(`call:${options?.model}`);
      return deepReviewResult;
    });

    const started: string[] = [];
    await runCliDeepReview({
      overallRisk: "HIGH",
      reviewPrompt: "prompt",
      onStart: (model) => {
        started.push(model);
        order.push(`start:${model}`);
      },
    });

    expect(started).toEqual([config.HQ_JR_MODEL_ESCALATION]);
    // The pending line is written before the model call starts.
    expect(order[0]).toBe(`start:${config.HQ_JR_MODEL_ESCALATION}`);
    expect(order[1]).toBe(`call:${config.HQ_JR_MODEL_ESCALATION}`);
    expect(formatDeepReviewPendingLine(config.HQ_JR_MODEL_ESCALATION)).toContain(
      config.HQ_JR_MODEL_ESCALATION
    );
  });

  it("names the fallback model in the header after the escalation model fails", async () => {
    vi.spyOn(aiModule, "runDeepReview")
      .mockRejectedValueOnce(new Error("escalation model unavailable"))
      .mockResolvedValueOnce(deepReviewResult);

    const started: string[] = [];
    const { header } = await runCliDeepReview({
      overallRisk: "HIGH",
      reviewPrompt: "prompt",
      onStart: (model) => started.push(model),
    });

    expect(started).toEqual([config.HQ_JR_MODEL_ESCALATION]);
    expect(header).toContain(config.HQ_JR_MODEL_TIER2);
    expect(header).toContain("fallback");
  });

  it("reports the same effective verdict the check run uses", async () => {
    const comment = {
      path: "src/auth.ts",
      line: 2,
      side: "RIGHT" as const,
      severity: "WARNING" as const,
      category: "BUG" as const,
      title: "Off by one",
      body: "Fix the bound.",
    };
    vi.spyOn(aiModule, "runDeepReview")
      .mockResolvedValueOnce({ ...deepReviewResult, verdict: "REQUEST_CHANGES", comments: [], unresolvedPriorIssues: [] })
      .mockResolvedValueOnce({
        ...deepReviewResult,
        verdict: "REQUEST_CHANGES",
        comments: [],
        unresolvedPriorIssues: ["The loop bound is still wrong."],
      })
      .mockResolvedValueOnce({ ...deepReviewResult, verdict: "APPROVE", comments: [comment] })
      .mockResolvedValueOnce({
        ...deepReviewResult,
        verdict: "APPROVE",
        comments: [{ ...comment, severity: "SUGGESTION" }],
      });

    const runs = [
      await runCliDeepReview({ overallRisk: "LOW", reviewPrompt: "prompt" }),
      await runCliDeepReview({ overallRisk: "LOW", reviewPrompt: "prompt" }),
      await runCliDeepReview({ overallRisk: "LOW", reviewPrompt: "prompt" }),
      await runCliDeepReview({ overallRisk: "LOW", reviewPrompt: "prompt" }),
    ];

    expect(runs.map((run) => run.result.verdict)).toEqual([
      "COMMENT",
      "REQUEST_CHANGES",
      "REQUEST_CHANGES",
      "APPROVE",
    ]);
  });
});

describe("CLI entry point guard", () => {
  /**
   * The path of src/cli.ts. The test file sits next to the module under test,
   * so the path is stable and points at the file the guard compares against.
   */
  const cliModulePath = fileURLToPath(new URL("./cli.ts", import.meta.url));

  it("does not run the CLI when the entry path is missing", () => {
    // A worker thread, `node -e`, or a test harness has no process.argv[1].
    expect(isCliEntryPoint(undefined)).toBe(false);
  });

  it("does not run the CLI when the entry path cannot be resolved", () => {
    // An entry path that does not exist is not proof that this module is the entry point.
    expect(isCliEntryPoint("/nonexistent/path/to/hq-jr-cli.js")).toBe(false);
  });

  it("does not run the CLI when the entry path is a different module", () => {
    expect(isCliEntryPoint(fileURLToPath(import.meta.url))).toBe(false);
  });

  it("runs the CLI when the entry path resolves to this module", () => {
    expect(isCliEntryPoint(cliModulePath)).toBe(true);
  });
});
