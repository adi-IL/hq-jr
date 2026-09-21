import { describe, it, expect, vi, beforeEach } from "vitest";
import appFn from "./index.js";
import { addRemediationCommit, acquireRunLock, releaseRunLock } from "./services/db.js";
import * as aiModule from "./services/ai.js";
import * as sandboxRunnerModule from "./services/sandbox-runner.js";

describe("hq-jr Event Handlers & Security Guards", () => {
  let handlers: Map<string, Function>;
  let mockApp: any;
  let octokitMock: any;

  beforeEach(() => {
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
});
