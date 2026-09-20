import { describe, it, expect, vi } from "vitest";
import { executeRemediation } from "./remediation.js";

vi.mock("./ai.js", () => ({
  ai: {
    models: {
      generateContent: vi.fn().mockResolvedValue({
        text: "```ts\nexport function fixedCode() { return true; }\n```",
      }),
    },
  },
  withRetry: (fn: any) => fn(),
}));

describe("remediation service", () => {
  it("creates a git commit and updates the branch ref", async () => {
    const mockOctokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            content: Buffer.from("export function originalCode() {}").toString("base64"),
          },
        }),
      },
      git: {
        createBlob: vi.fn().mockResolvedValue({ data: { sha: "blob-sha-123" } }),
        getCommit: vi.fn().mockResolvedValue({ data: { tree: { sha: "base-tree-sha" } } }),
        createTree: vi.fn().mockResolvedValue({ data: { sha: "new-tree-sha" } }),
        createCommit: vi.fn().mockResolvedValue({ data: { sha: "new-commit-sha" } }),
        createRef: vi.fn().mockResolvedValue({ data: {} }),
        updateRef: vi.fn().mockResolvedValue({ data: {} }),
      },
      pulls: {
        create: vi.fn().mockResolvedValue({
          data: { html_url: "https://github.com/owner/repo/pull/10" },
        }),
      },
    };

    const result = await executeRemediation({
      octokit: mockOctokit,
      owner: "owner",
      repo: "repo",
      pullNumber: 9,
      pr: {
        head: { ref: "feature-branch", sha: "parent-sha-000" },
        base: { ref: "main", sha: "main-sha-000" },
      },
      issues: [
        {
          id: 1,
          path: "src/api.ts",
          line: 10,
          side: "RIGHT",
          title: "Unhandled exception",
          body: "Add try/catch block",
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.commitSha).toBe("new-commit-sha");
    expect(result.filesModified).toContain("src/api.ts");
    expect(mockOctokit.git.createCommit).toHaveBeenCalled();
  });

  it("handles case where no issues are provided", async () => {
    const mockOctokit = {};
    const result = await executeRemediation({
      octokit: mockOctokit,
      owner: "owner",
      repo: "repo",
      pullNumber: 9,
      pr: { head: { ref: "feature", sha: "sha" } },
      issues: [],
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("No open review issues found");
  });

  it("handles 403 permission denied with clear instructions and synthesized fallback", async () => {
    const mockOctokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            content: Buffer.from("export function broken() {}").toString("base64"),
          },
        }),
      },
      git: {
        createBlob: vi.fn().mockRejectedValue({
          status: 403,
          message: "Resource not accessible by integration",
        }),
      },
    };

    const result = await executeRemediation({
      octokit: mockOctokit,
      owner: "owner",
      repo: "repo",
      pullNumber: 9,
      pr: { head: { ref: "feature", sha: "sha" } },
      issues: [
        {
          id: 1,
          path: "src/broken.ts",
          line: 1,
          side: "RIGHT",
          title: "Broken",
          body: "Fix it",
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Permission Required to Commit");
    expect(result.message).toContain("Contents: Read and write");
    expect(result.message).toContain("Synthesized Fixes (Ready to Apply)");
    expect(result.filesModified).toContain("src/broken.ts");
  });
});
