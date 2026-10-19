import type { ReviewComment, DeepReviewResult } from "../schemas/review.js";

interface RefLookupOctokit {
  git: { getRef(params: { owner: string; repo: string; ref: string }): Promise<unknown> };
  repos: { getCommit(params: { owner: string; repo: string; ref: string }): Promise<unknown> };
}

const MISSING_CLAIM_RE =
  /\b(?:does not exist|doesn't exist|non-?existent|not exist|no such (?:tag|version|release|ref)|(?:is|was) not found|cannot be found|could not be (?:found|resolved)|unable to resolve|(?:is )?not a valid (?:version|tag|release|ref)|invalid (?:action )?(?:version|tag|ref))\b/i;
// owner/repo[/path]@ref. Must not start inside a URL or path, and the ref may contain "/".
const ACTION_REF_RE = /(?<![\w./:@-])([A-Za-z0-9][\w.-]*)\/([\w.-]+)(?:\/[\w.-]+)*@([\w./-]*[\w-])/g;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const SENTENCE_SPLIT_RE = /(?<=[.;!?])\s+|\n+/;

type RefState = "exists" | "missing" | "unknown";
type Ref = { owner: string; repo: string; ref: string };

async function lookup(fn: () => Promise<unknown>): Promise<RefState> {
  try {
    await fn();
    return "exists";
  } catch (err: any) {
    // A 404 also covers repos the installation cannot see (private actions).
    // That reads as "missing", so the finding is kept: the safe direction.
    return err?.status === 404 ? "missing" : "unknown";
  }
}

async function resolveRef(octokit: RefLookupOctokit, { owner, repo, ref }: Ref): Promise<RefState> {
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

const refKey = (r: Ref) => `${r.owner}/${r.repo}@${r.ref}`;

/**
 * Refs a sentence claims are missing. Only refs in the claiming sentence count,
 * and refs before the claim phrase win over later ones ("X does not exist, use Y").
 */
function claimedRefs(text: string): Ref[] {
  const out: Ref[] = [];
  for (const sentence of text.split(SENTENCE_SPLIT_RE)) {
    const claim = MISSING_CLAIM_RE.exec(sentence);
    if (!claim) continue;
    const refs = [...sentence.matchAll(ACTION_REF_RE)].map((m) => ({
      owner: m[1],
      repo: m[2],
      ref: m[3],
      index: m.index ?? 0,
    }));
    const before = refs.filter((r) => r.index < claim.index);
    for (const { owner, repo, ref } of before.length ? before : refs) out.push({ owner, repo, ref });
  }
  return out;
}

export async function dropUnverifiedMissingActionRefs(
  octokit: RefLookupOctokit,
  comments: ReviewComment[],
  dropped: Ref[] = []
): Promise<ReviewComment[]> {
  const cache = new Map<string, Promise<RefState>>();
  const kept: ReviewComment[] = [];

  for (const comment of comments) {
    const refs = claimedRefs(`${comment.title}\n${comment.body}`);
    if (refs.length === 0) {
      kept.push(comment);
      continue;
    }

    let allConfirmedMissing = true;
    for (const r of refs) {
      const key = refKey(r);
      if (!cache.has(key)) cache.set(key, resolveRef(octokit, r));
      if ((await cache.get(key)) !== "missing") allConfirmedMissing = false;
    }
    if (allConfirmedMissing) kept.push(comment);
    else dropped.push(...refs);
  }

  return kept;
}

/**
 * Apply the filter to a full review: drop false missing-ref findings, remove
 * summary sentences that repeat them, and stop requesting changes when no
 * blocking finding is left.
 */
export async function verifyReviewActionRefs<T extends Pick<DeepReviewResult, "comments" | "summary" | "verdict">>(
  octokit: RefLookupOctokit,
  review: T
): Promise<T> {
  const dropped: Ref[] = [];
  const comments = await dropUnverifiedMissingActionRefs(octokit, review.comments, dropped);
  if (dropped.length === 0) return review;

  const droppedKeys = new Set(dropped.map(refKey));
  const summary = review.summary
    .split(SENTENCE_SPLIT_RE)
    .filter((s) => !claimedRefs(s).some((r) => droppedKeys.has(refKey(r))))
    .join(" ")
    .trim();
  const removed = review.comments.length - comments.length;
  const note = `${removed} finding(s) claiming a missing action ref were dropped after the ref was found upstream.`;
  const blocking = comments.some((c) => c.severity !== "SUGGESTION");
  const verdict = review.verdict === "REQUEST_CHANGES" && !blocking ? "COMMENT" : review.verdict;

  return { ...review, comments, summary: summary ? `${summary}\n\n${note}` : note, verdict };
}
