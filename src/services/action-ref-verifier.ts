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
/** The title of a comment whose own title was a dropped claim. */
const REPLACEMENT_TITLE = "Finding (action ref claim removed)";

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
  const failed: Ref[] = [];
  let found = false;
  for (const r of refs) {
    const key = refKey(r);
    if (!cache.has(key)) cache.set(key, resolveRef(octokit, r));
    const state = await cache.get(key)!;
    // A ref that is confirmed missing backs a true claim, so that claim stays
    // even when another claim in the same text is false.
    if (state === "missing") continue;
    failed.push(r);
    if (state === "exists") found = true;
  }
  if (failed.length === 0) return null;
  return { refs: failed, reason: found ? "found" : "unverified" };
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
    if (!verdict) {
      kept.push(comment);
      continue;
    }
    dropped.push(verdict);
    // The claim is false, but the comment can carry other findings, so the
    // sentences that carry the claim are removed and the rest of the comment
    // is kept. A comment whose whole body was the claim is dropped, because
    // nothing else in it stands on its own.
    const droppedKeys = new Set(verdict.refs.map(refKey));
    const title = scrubSentences(comment.title, droppedKeys);
    const body = scrubSentences(comment.body, droppedKeys);
    if (body === "") continue;
    if (title === "") {
      // The title was the claim. The body is the comment's own finding only
      // when it does not talk about the action, so it is kept under a title
      // taken from it. A body that names the action is the claim's own
      // explanation and goes with the claim.
      if (namesAction(comment.body, verdict.refs)) continue;
      kept.push({ ...comment, title: REPLACEMENT_TITLE, body });
      continue;
    }
    kept.push({ ...comment, title, body });
  }
  return kept;
}

/**
 * Remove sentences that carry a dropped claim, keeping the original
 * separators and line breaks. A sentence that claims a ref whose claim failed
 * verification goes even when it also names a ref whose claim is true: the
 * false claim cannot stay.
 */
function scrubSentences(text: string, droppedKeys: Set<string>): string {
  const parts = text.split(/((?<=[.;!?])[ \t]+|\n+)/);
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    const sep = parts[i + 1] ?? "";
    const refs = claimedRefs(sentence);
    if (refs.length > 0 && refs.some((r) => droppedKeys.has(refKey(r)))) {
      if (sep.includes("\n")) out = out.replace(/[ \t]+$/, "") + sep;
      continue;
    }
    out += sentence + sep;
  }
  return out.trim();
}

/** True when the text names one of the actions whose claim was dropped. */
function namesAction(text: string, refs: Ref[]): boolean {
  return refs.some((r) => text.includes(`${r.owner}/${r.repo}`));
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
    if (!verdict) {
      unresolved.push(issue);
      continue;
    }
    priorDropped.push(verdict);
    // The issue can carry more than the failed claim, so the sentences that
    // carry the claim are removed and the rest of the issue stays unresolved.
    const rest = scrubSentences(issue, new Set(verdict.refs.map(refKey)));
    if (rest !== "") unresolved.push(rest);
  }
  if (dropped.length === 0 && priorDropped.length === 0) return review;

  const droppedKeys = new Set([...dropped, ...priorDropped].flatMap((d) => d.refs.map(refKey)));
  const summary = scrubSentences(review.summary, droppedKeys);
  const note = dropNote([...dropped, ...priorDropped]);

  const out: T = { ...review, comments, summary: summary ? `${summary}\n\n${note}` : note };
  if (review.unresolvedPriorIssues) out.unresolvedPriorIssues = unresolved;
  return out;
}
