import { describe, it, expect, vi } from "vitest";
import { dropUnverifiedMissingActionRefs, verifyReviewActionRefs } from "./action-ref-verifier.js";
import { resolveVerdict } from "./ai.js";
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

describe("action ref verification edge cases", () => {
  const sha = "a".repeat(40);
  const missingSha = "b".repeat(40);

  it("checks pinned SHAs through repos.getCommit", async () => {
    const base = fakeOctokit({ "actions/checkout": [sha] });
    // Tags and branches never match a SHA, so only getCommit can find it.
    const octokit = { ...base, git: { getRef: vi.fn(async () => { throw notFound(); }) } };
    const exists = comment({ body: `actions/checkout@${sha} does not exist.` });
    const missing = comment({ body: `actions/checkout@${missingSha} does not exist.` });

    expect(await dropUnverifiedMissingActionRefs(octokit, [exists, missing])).toEqual([missing]);
    expect(octokit.repos.getCommit).toHaveBeenCalledWith({ owner: "actions", repo: "checkout", ref: sha });
  });

  it("verifies other missing-ref phrasings", async () => {
    const octokit = fakeOctokit({ "actions/checkout": ["v7"] });
    const bodies = [
      "actions/checkout@v7 is not found upstream.",
      "actions/checkout@v7 is not a valid version.",
      "The runner is unable to resolve actions/checkout@v7.",
    ];
    expect(await dropUnverifiedMissingActionRefs(octokit, bodies.map((body) => comment({ body })))).toEqual([]);
  });

  it("keeps a finding that only mentions a ref without claiming it is missing", async () => {
    const octokit = fakeOctokit({ "actions/cache": ["v4"] });
    const c = comment({ body: "actions/cache@v4 is used here. The cache key misses the lockfile hash." });
    expect(await dropUnverifiedMissingActionRefs(octokit, [c])).toEqual([c]);
  });

  it("checks only the claimed ref, not the suggested replacement", async () => {
    const octokit = fakeOctokit({ "actions/setup-node": ["v4"] });
    const sameSentence = comment({ body: "actions/setup-node@v3 does not exist, use actions/setup-node@v4." });
    const nextSentence = comment({ body: "actions/setup-node@v3 does not exist. Use actions/setup-node@v4 instead." });
    expect(await dropUnverifiedMissingActionRefs(octokit, [sameSentence, nextSentence])).toEqual([
      sameSentence,
      nextSentence,
    ]);
  });

  it("parses refs with slashes and ignores refs inside URLs", async () => {
    const octokit = fakeOctokit({ "owner/action": ["release/v1"] });
    const slash = comment({ body: "owner/action@release/v1 does not exist." });
    expect(await dropUnverifiedMissingActionRefs(octokit, [slash])).toEqual([]);

    const url = comment({ body: "See https://github.com/owner/action@release/v1 which does not exist." });
    expect(await dropUnverifiedMissingActionRefs(octokit, [url])).toEqual([url]);
  });

  it("drops false findings and leaves the verdict for the caller to resolve", async () => {
    const octokit = fakeOctokit({ "actions/checkout": ["v7"] });
    const review = {
      verdict: "REQUEST_CHANGES" as const,
      summary: "actions/checkout@v7 does not exist. Otherwise the change is fine.",
      comments: [comment({ body: "actions/checkout@v7 does not exist." })],
    };
    const out = await verifyReviewActionRefs(octokit, review);
    expect(out.verdict).toBe("REQUEST_CHANGES");
    expect(out.comments).toEqual([]);
    expect(resolveVerdict(out)).toBe("COMMENT");
    expect(out.summary).not.toContain("does not exist");
    expect(out.summary).toContain("Otherwise the change is fine.");
  });

  it("keeps REQUEST_CHANGES when a blocking finding remains", async () => {
    const octokit = fakeOctokit({ "actions/checkout": ["v7"] });
    const out = await verifyReviewActionRefs(octokit, {
      verdict: "REQUEST_CHANGES" as const,
      summary: "s",
      comments: [comment({ body: "actions/checkout@v7 does not exist." }), comment({ title: "Real bug", body: "Off by one." })],
    });
    expect(out.verdict).toBe("REQUEST_CHANGES");
    expect(resolveVerdict(out)).toBe("REQUEST_CHANGES");
    expect(out.comments.map((c) => c.title)).toEqual(["Real bug"]);
  });
});

describe("verifyReviewActionRefs prior issues and notes", () => {
  it("drops prior issues whose claimed ref exists and keeps the rest", async () => {
    const octokit = fakeOctokit({ "actions/checkout": ["v7"] });
    const out = await verifyReviewActionRefs(octokit, {
      verdict: "REQUEST_CHANGES" as const,
      summary: "s",
      comments: [],
      unresolvedPriorIssues: ["actions/checkout@v7 does not exist.", "Off-by-one in loop bound is still open."],
    });
    expect(out.unresolvedPriorIssues).toEqual(["Off-by-one in loop bound is still open."]);
    expect(out.verdict).toBe("REQUEST_CHANGES");
    expect(resolveVerdict(out)).toBe("REQUEST_CHANGES");
  });

  it("leaves the verdict unchanged when the only prior issue was a false claim", async () => {
    const octokit = fakeOctokit({ "actions/checkout": ["v7"] });
    const out = await verifyReviewActionRefs(octokit, {
      verdict: "REQUEST_CHANGES" as const,
      summary: "s",
      comments: [],
      unresolvedPriorIssues: ["actions/checkout@v7 does not exist."],
    });
    expect(out.unresolvedPriorIssues).toEqual([]);
    expect(out.verdict).toBe("REQUEST_CHANGES");
    expect(resolveVerdict(out)).toBe("COMMENT");
  });

  it("says the claim was unverified when the lookup failed", async () => {
    const octokit = {
      git: { getRef: vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 500 }); }) },
      repos: { getCommit: vi.fn() },
    };
    const out = await verifyReviewActionRefs(octokit, {
      verdict: "COMMENT" as const,
      summary: "s",
      comments: [comment({ body: "actions/checkout@v7 does not exist." })],
    });
    expect(out.summary).toContain("could not be verified");
    expect(out.summary).not.toContain("exists upstream");
  });

  it("says the ref exists when it was found", async () => {
    const octokit = fakeOctokit({ "actions/checkout": ["v7"] });
    const out = await verifyReviewActionRefs(octokit, {
      verdict: "COMMENT" as const,
      summary: "s",
      comments: [comment({ body: "actions/checkout@v7 does not exist." })],
    });
    expect(out.summary).toContain("exists upstream");
    expect(out.summary).not.toContain("could not be verified");
  });

  it("keeps line breaks and markdown in the summary while removing the false sentence", async () => {
    const octokit = fakeOctokit({ "actions/checkout": ["v7"] });
    const out = await verifyReviewActionRefs(octokit, {
      verdict: "COMMENT" as const,
      summary: "## Overview\n\n- First point. actions/checkout@v7 does not exist.\n- Second point.",
      comments: [comment({ body: "actions/checkout@v7 does not exist." })],
    });
    expect(out.summary.startsWith("## Overview\n\n- First point.\n- Second point.")).toBe(true);
  });

  it("returns the review unchanged when nothing is dropped", async () => {
    const octokit = fakeOctokit({});
    const review = { verdict: "REQUEST_CHANGES" as const, summary: "a\n\nb", comments: [comment({})] };
    expect(await verifyReviewActionRefs(octokit, review)).toBe(review);
  });
});
