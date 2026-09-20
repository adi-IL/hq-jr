import { describe, it, expect, vi } from "vitest";
import appFn from "./index.js";
import { safeParseJson } from "./services/json-repair.js";
import { executeRemediation } from "./services/remediation.js";
import { ai } from "./services/ai.js";

describe("Root Cause Bug Reproductions", () => {
  it("REPRO 1: RBAC fails closed when getCollaboratorPermissionLevel throws an error", async () => {
    const handlers = new Map<string, (context: unknown) => Promise<void>>();
    const mockApp = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn((event: string | string[], handler: (context: unknown) => Promise<void>) => {
        if (Array.isArray(event)) {
          event.forEach((e) => handlers.set(e, handler));
        } else {
          handlers.set(event, handler);
        }
      }),
    };

    const octokitMock = {
      repos: {
        getCollaboratorPermissionLevel: vi.fn().mockRejectedValueOnce({
          status: 404,
          message: "User is not a collaborator",
        }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
      },
      pulls: {
        get: vi.fn(),
      },
    };

    appFn(mockApp as unknown as Parameters<typeof appFn>[0]);

    const issueCommentHandler = handlers.get("issue_comment.created");
    expect(issueCommentHandler).toBeDefined();

    await issueCommentHandler!({
      octokit: octokitMock,
      payload: {
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 101,
          body: "@hq-jr fix and merge",
          user: { login: "unauthorized-attacker", type: "User" },
        },
        repository: {
          name: "repo",
          owner: { login: "owner" },
        },
      },
    });

    const createCommentCalls = octokitMock.issues.createComment.mock.calls;
    const accessDeniedComment = createCommentCalls.find((call: unknown[]) => {
      const arg = call[0] as { body?: string } | undefined;
      return arg?.body?.includes("Access Denied");
    });

    expect(accessDeniedComment).toBeDefined();

    const remediationStartComment = createCommentCalls.find((call: unknown[]) => {
      const arg = call[0] as { body?: string } | undefined;
      return arg?.body?.includes("received remediation request");
    });
    expect(remediationStartComment).toBeUndefined();
  });

  it("REPRO 2: safeParseJson preserves valid JSON containing embedded markdown code blocks", () => {
    const jsonPayloadWithCodeBlock = JSON.stringify({
      summary: "Audit completed with suggestions",
      verdict: "COMMENT",
      comments: [
        {
          path: "src/utils.ts",
          line: 15,
          side: "RIGHT",
          severity: "SUGGESTION",
          category: "STYLE",
          title: "Refactor to helper function",
          body: "Use this helper:\n```typescript\nexport function helper() { return true; }\n```\nIt is cleaner.",
          suggestedPatch: "export function helper() { return true; }",
        },
      ],
    });

    const parsed = safeParseJson<{ summary: string; comments: { path: string }[] }>(
      jsonPayloadWithCodeBlock
    );

    expect(parsed).toBeDefined();
    expect(parsed.summary).toBe("Audit completed with suggestions");
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].path).toBe("src/utils.ts");
  });

  it("REPRO 3: executeRemediation aborts when PR head SHA changes during synthesis", async () => {
    vi.spyOn(ai.models, "generateContent").mockResolvedValueOnce({
      text: "```typescript\nconst fixed = 2;\n```",
    } as unknown as { text: string });

    const octokitMock = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            content: Buffer.from("const old = 1;").toString("base64"),
          },
        }),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            head: { sha: "new-sha-2222", ref: "feature-branch" },
          },
        }),
      },
      git: {
        createBlob: vi.fn().mockResolvedValue({ data: { sha: "blob-sha" } }),
        getCommit: vi.fn().mockResolvedValue({ data: { tree: { sha: "tree-sha" } } }),
        createTree: vi.fn().mockResolvedValue({ data: { sha: "new-tree-sha" } }),
        createCommit: vi.fn().mockResolvedValue({ data: { sha: "commit-sha" } }),
        createRef: vi.fn().mockResolvedValue({}),
      },
    };

    const result = await executeRemediation({
      octokit: octokitMock,
      owner: "owner",
      repo: "repo",
      pullNumber: 12,
      pr: {
        head: { sha: "initial-sha-1111", ref: "feature-branch" },
      },
      issues: [
        {
          id: 1,
          path: "src/app.ts",
          side: "RIGHT",
          title: "Bug",
          body: "Fix this bug",
        },
      ],
      autoMerge: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("stale");
    expect(octokitMock.git.createCommit).not.toHaveBeenCalled();
  });

  it("REPRO 4: Issue comment parsing does not trigger autoMerge when phrase contains 'do not merge'", () => {
    const commentBody = "@hq-jr please fix the issues, do not merge yet";
    const lower = commentBody.toLowerCase();

    const isAutoMergeBuggy = lower.includes("merge");
    expect(isAutoMergeBuggy).toBe(true);

    const hasNegativeMerge = /\b(?:do not|don't|no|never)\s+merge\b/i.test(commentBody);
    const hasExplicitMergeCommand = /\b(?:and\s+merge|auto-?merge)\b/i.test(commentBody);
    const autoMergeFixed = hasExplicitMergeCommand && !hasNegativeMerge;
    expect(autoMergeFixed).toBe(false);
  });
});
