import { describe, it, expect, vi } from "vitest";
import { dropUnverifiedMissingActionRefs } from "./action-ref-verifier.js";
import type { ReviewComment } from "../schemas/review.js";

const comment = (overrides: Partial<ReviewComment>): ReviewComment => ({
  path: ".github/workflows/ci.yml",
  line: 35,
  side: "RIGHT",
  severity: "WARNING",
  category: "BUG",
  title: "Unrelated",
  body: "Unrelated",
  ...overrides,
});

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

function fakeOctokit(existing: Record<string, string[]>) {
  const has = (owner: string, repo: string, ref: string) =>
    (existing[`${owner}/${repo}`] ?? []).includes(ref);
  return {
    git: {
      getRef: vi.fn(async ({ owner, repo, ref }: { owner: string; repo: string; ref: string }) => {
        const name = ref.replace(/^(tags|heads)\//, "");
        if (has(owner, repo, name)) return { data: { ref } };
        throw notFound();
      }),
    },
    repos: {
      getCommit: vi.fn(async ({ owner, repo, ref }: { owner: string; repo: string; ref: string }) => {
        if (has(owner, repo, ref)) return { data: { sha: ref } };
        throw notFound();
      }),
    },
  };
}

describe("dropUnverifiedMissingActionRefs", () => {
  it("drops the MidSphere#1 false positives for tags that exist", async () => {
    const octokit = fakeOctokit({
      "actions/checkout": ["v7"],
      "dorny/paths-filter": ["v4"],
    });
    const comments = [
      comment({
        title: "Non-existent action version actions/checkout@v7",
        body: "The action actions/checkout@v7 does not exist; actions/checkout is currently on major version v4. The job will fail during action download.",
        suggestedPatch: "      - uses: actions/checkout@v4",
      }),
      comment({
        line: 36,
        title: "Non-existent action version dorny/paths-filter@v4",
        body: "The action dorny/paths-filter@v4 does not exist; the latest major release is v3. The job will fail during action resolution.",
        suggestedPatch: "      - uses: dorny/paths-filter@v3",
      }),
      comment({ title: "Real bug", body: "Off-by-one in loop bound." }),
    ];

    const kept = await dropUnverifiedMissingActionRefs(octokit, comments);

    expect(kept.map((c) => c.title)).toEqual(["Real bug"]);
  });

  it("keeps the finding when the ref is confirmed missing", async () => {
    const octokit = fakeOctokit({ "actions/checkout": ["v4"] });
    const c = comment({
      title: "Non-existent action version actions/checkout@v99",
      body: "actions/checkout@v99 does not exist.",
    });

    expect(await dropUnverifiedMissingActionRefs(octokit, [c])).toEqual([c]);
  });

  it("drops the finding when the lookup cannot confirm the ref is missing", async () => {
    const octokit = {
      git: { getRef: vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 500 }); }) },
      repos: { getCommit: vi.fn(async () => { throw notFound(); }) },
    };
    const c = comment({ body: "google-github-actions/auth@v3 does not exist." });

    expect(await dropUnverifiedMissingActionRefs(octokit, [c])).toEqual([]);
  });

  it("checks the owner/repo of sub-path actions", async () => {
    const octokit = fakeOctokit({ "github/codeql-action": ["v4"] });
    const c = comment({ body: "github/codeql-action/init@v4 does not exist." });

    expect(await dropUnverifiedMissingActionRefs(octokit, [c])).toEqual([]);
    expect(octokit.git.getRef).toHaveBeenCalledWith({ owner: "github", repo: "codeql-action", ref: "tags/v4" });
  });
});
