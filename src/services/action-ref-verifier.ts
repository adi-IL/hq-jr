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

export type DropReason = "found" | "unverified";
export interface DroppedClaim {
  refs: Ref[];
  /** "found": a claimed ref exists upstream. "unverified": a lookup failed, so the claim could not be confirmed. */
  reason: DropReason;
}

type Cache = Map<string, Promise<RefState>>;

/** Decide one text. Returns null to keep it, or why it should be dropped. */
async function judge(octokit: RefLookupOctokit, cache: Cache, text: string): Promise<DroppedClaim | null> {
  const refs = claimedRefs(text);
  if (refs.length === 0) return null;
  const states: RefState[] = [];
  for (const r of refs) {
    const key = refKey(r);
    if (!cache.has(key)) cache.set(key, resolveRef(octokit, r));
    states.push(await cache.get(key)!);
  }
  if (states.every((st) => st === "missing")) return null;
  return { refs, reason: states.includes("exists") ? "found" : "unverified" };
}

export async function dropUnverifiedMissingActionRefs(
  octokit: RefLookupOctokit,
  comments: ReviewComment[],
  dropped: DroppedClaim[] = [],
  cache: Cache = new Map()
): Promise<ReviewComment[]> {
  const kept: ReviewComment[] = [];
  for (const comment of comments) {
    const verdict = await judge(octokit, cache, `${comment.title}\n${comment.body}`);
    if (verdict) dropped.push(verdict);
    else kept.push(comment);
  }
  return kept;
}

/** Remove sentences that repeat a dropped claim, keeping the original separators and line breaks. */
function scrubSentences(text: string, droppedKeys: Set<string>): string {
  const parts = text.split(/((?<=[.;!?])[ \t]+|\n+)/);
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    const sep = parts[i + 1] ?? "";
    const refs = claimedRefs(sentence);
    if (refs.length > 0 && refs.every((r) => droppedKeys.has(refKey(r)))) {
      if (sep.includes("\n")) out = out.replace(/[ \t]+$/, "") + sep;
      continue;
    }
    out += sentence + sep;
  }
  return out.trim();
}

function dropNote(dropped: DroppedClaim[]): string {
  const found = dropped.filter((d) => d.reason === "found").length;
  const unverified = dropped.length - found;
  const parts: string[] = [];
  if (found) parts.push(`${found} finding(s) claiming a missing action ref were dropped because the ref exists upstream.`);
  if (unverified) {
    parts.push(`${unverified} finding(s) claiming a missing action ref were dropped because the claim could not be verified (ref lookup failed).`);
  }
  return parts.join(" ");
}

type VerifiableReview = Pick<DeepReviewResult, "comments" | "summary" | "verdict"> & {
  unresolvedPriorIssues?: string[];
};

/**
 * Apply the filter to a full review: drop false missing-ref findings and prior
 * issues, and remove summary sentences that repeat them. The verdict is left
 * as the model wrote it. The caller resolves it against the comment list and
 * the prior issues this function returns.
 */
export async function verifyReviewActionRefs<T extends VerifiableReview>(octokit: RefLookupOctokit, review: T): Promise<T> {
  const cache: Cache = new Map();
  const dropped: DroppedClaim[] = [];
  const comments = await dropUnverifiedMissingActionRefs(octokit, review.comments, dropped, cache);

  const priorDropped: DroppedClaim[] = [];
  const unresolved: string[] = [];
  for (const issue of review.unresolvedPriorIssues ?? []) {
    const verdict = await judge(octokit, cache, issue);
    if (verdict) priorDropped.push(verdict);
    else unresolved.push(issue);
  }
  if (dropped.length === 0 && priorDropped.length === 0) return review;

  const droppedKeys = new Set([...dropped, ...priorDropped].flatMap((d) => d.refs.map(refKey)));
  const summary = scrubSentences(review.summary, droppedKeys);
  const note = dropNote([...dropped, ...priorDropped]);

  const out: T = { ...review, comments, summary: summary ? `${summary}\n\n${note}` : note };
  if (review.unresolvedPriorIssues) out.unresolvedPriorIssues = unresolved;
  return out;
}
