import { describe, it, expect, vi } from "vitest";
import { getPreviousReviewContext, getReviewCommentThread } from "./review-memory.js";

describe("review-memory service", () => {
  it("extracts the latest hq-jr review and parses open issues", async () => {
    const mockOctokit = {
      pulls: {
        listReviews: vi.fn().mockResolvedValue({
          data: [
            {
              id: 101,
              user: { login: "some-user" },
              state: "APPROVED",
              body: "Looks good!",
              commit_id: "sha-1",
            },
            {
              id: 102,
              user: { login: "hq-jr[bot]" },
              state: "CHANGES_REQUESTED",
              body: "Found 2 bugs",
              commit_id: "sha-2",
            },
          ],
        }),
        listCommentsForReview: vi.fn().mockResolvedValue({
          data: [
            {
              id: 501,
              path: "src/api.ts",
              line: 42,
              side: "RIGHT",
              body: "### [BUG] Unhandled rejection\nMissing await on async call",
            },
            {
              id: 502,
              path: "src/auth.ts",
              line: 15,
              side: "RIGHT",
              body: "### [SECURITY] Missing token check\nToken is not verified",
            },
          ],
        }),
      },
    };

    const result = await getPreviousReviewContext({
      octokit: mockOctokit,
      owner: "owner",
      repo: "repo",
      pullNumber: 9,
    });

    expect(result).not.toBeNull();
    expect(result?.reviewId).toBe(102);
    expect(result?.lastCommitSha).toBe("sha-2");
    expect(result?.verdict).toBe("CHANGES_REQUESTED");
    expect(result?.openIssues).toHaveLength(2);
    expect(result?.openIssues[0].path).toBe("src/api.ts");
    expect(result?.openIssues[0].line).toBe(42);
    expect(result?.openIssues[0].title).toBe("[BUG] Unhandled rejection");
    expect(result?.openIssues[1].title).toBe("[SECURITY] Missing token check");
  });

  it("returns null if no bot reviews exist", async () => {
    const mockOctokit = {
      pulls: {
        listReviews: vi.fn().mockResolvedValue({
          data: [
            {
              id: 101,
              user: { login: "human-dev" },
              state: "APPROVED",
              body: "LGTM",
              commit_id: "sha-1",
            },
          ],
        }),
      },
    };

    const result = await getPreviousReviewContext({
      octokit: mockOctokit,
      owner: "owner",
      repo: "repo",
      pullNumber: 9,
    });

    expect(result).toBeNull();
  });

  it("reconstructs multi-turn comment threads in chronological order", async () => {
    const mockOctokit = {
      pulls: {
        listReviewComments: vi.fn().mockResolvedValue({
          data: [
            {
              id: 301,
              user: { login: "hq-jr[bot]", type: "Bot" },
              body: "Initial comment",
              created_at: "2026-09-17T20:00:00Z",
            },
            {
              id: 303,
              in_reply_to_id: 301,
              user: { login: "test-developer", type: "User" },
              body: "I updated this in commit b171e5c",
              created_at: "2026-09-17T20:10:00Z",
            },
            {
              id: 302,
              in_reply_to_id: 301,
              user: { login: "test-developer", type: "User" },
              body: "Does this look right?",
              created_at: "2026-09-17T20:05:00Z",
            },
            {
              id: 400,
              body: "Unrelated thread comment",
              created_at: "2026-09-17T20:00:00Z",
            },
          ],
        }),
      },
    };

    const thread = await getReviewCommentThread({
      octokit: mockOctokit,
      owner: "owner",
      repo: "repo",
      pullNumber: 9,
      commentId: 303,
      inReplyToId: 301,
    });

    expect(thread).toHaveLength(3);
    expect(thread[0].id).toBe(301);
    expect(thread[0].isBot).toBe(true);
    expect(thread[1].id).toBe(302);
    expect(thread[2].id).toBe(303);
    expect(thread[2].body).toBe("I updated this in commit b171e5c");
  });
});
