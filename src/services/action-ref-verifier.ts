import type { ReviewComment } from "../schemas/review.js";

interface RefLookupOctokit {
  git: { getRef(params: { owner: string; repo: string; ref: string }): Promise<unknown> };
  repos: { getCommit(params: { owner: string; repo: string; ref: string }): Promise<unknown> };
}

const MISSING_CLAIM_RE = /\b(?:does not exist|doesn't exist|non-?existent|not exist|no such (?:tag|version|release))\b/i;
const ACTION_REF_RE = /\b([A-Za-z0-9][\w.-]*)\/([\w.-]+)(?:\/[\w./-]+)?@([\w.-]+)/g;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

type RefState = "exists" | "missing" | "unknown";

async function lookup(fn: () => Promise<unknown>): Promise<RefState> {
  try {
    await fn();
    return "exists";
  } catch (err: any) {
    return err?.status === 404 ? "missing" : "unknown";
  }
}

async function resolveRef(octokit: RefLookupOctokit, owner: string, repo: string, ref: string): Promise<RefState> {
  const attempts = [
    () => octokit.git.getRef({ owner, repo, ref: `tags/${ref}` }),
    () => octokit.git.getRef({ owner, repo, ref: `heads/${ref}` }),
  ];
  if (SHA_RE.test(ref)) attempts.push(() => octokit.repos.getCommit({ owner, repo, ref }));

  let state: RefState = "missing";
  for (const attempt of attempts) {
    const result = await lookup(attempt);
    if (result === "exists") return "exists";
    if (result === "unknown") state = "unknown";
  }
  return state;
}

export async function dropUnverifiedMissingActionRefs(
  octokit: RefLookupOctokit,
  comments: ReviewComment[]
): Promise<ReviewComment[]> {
  const cache = new Map<string, Promise<RefState>>();
  const kept: ReviewComment[] = [];

  for (const comment of comments) {
    const text = `${comment.title}\n${comment.body}`;
    if (!MISSING_CLAIM_RE.test(text)) {
      kept.push(comment);
      continue;
    }

    const refs = [...text.matchAll(ACTION_REF_RE)].map(([, owner, repo, ref]) => ({ owner, repo, ref }));
    if (refs.length === 0) {
      kept.push(comment);
      continue;
    }

    let allConfirmedMissing = true;
    for (const { owner, repo, ref } of refs) {
      const key = `${owner}/${repo}@${ref}`;
      if (!cache.has(key)) cache.set(key, resolveRef(octokit, owner, repo, ref));
      if ((await cache.get(key)) !== "missing") allConfirmedMissing = false;
    }
    if (allConfirmedMissing) kept.push(comment);
  }

  return kept;
}
