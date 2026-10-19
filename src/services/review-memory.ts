import { scrubSecrets } from "./scrubber.js";
import {
  getReviewFindingsForPull,
  type ReviewFindingRow,
} from "./db.js";
import { isHqJrLogin } from "../hq-jr-login.js";

export interface PriorReviewIssue {
  id: number;
  path: string;
  line?: number;
  side: "RIGHT" | "LEFT";
  title?: string;
  body: string;
}

export interface PreviousReviewContext {
  reviewId: number;
  lastCommitSha: string;
  verdict: string;
  summary: string;
  openIssues: PriorReviewIssue[];
  /** True when openIssues came primarily from SQLite prior findings. */
  source?: "sqlite" | "github" | "merged";
}

export interface ThreadTurn {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  isBot: boolean;
}

function scrubIssueBody(body: string): string {
  return scrubSecrets(body).scrubbed;
}

function findingToIssue(f: ReviewFindingRow, syntheticId: number): PriorReviewIssue {
  return {
    id: f.id ?? syntheticId,
    path: f.path,
    line: f.line ?? undefined,
    side: (f.side === "LEFT" ? "LEFT" : "RIGHT") as "RIGHT" | "LEFT",
    title: f.title ? scrubIssueBody(f.title) : undefined,
    body: scrubIssueBody(f.body),
  };
}

function normalizeIssueTitle(title: string | undefined): string {
  if (!title) return "";
  // Strip leading [CATEGORY] so GitHub heading titles and SQLite titles collide.
  return title.replace(/^\[[^\]]+\]\s*/, "").trim();
}

/**
 * Deduplicate issues by path|line|normalizedTitle||bodySlice.
 * Primary list wins on collision (pass fresher GitHub first when merging).
 */
function mergeIssues(
  primary: PriorReviewIssue[],
  secondary: PriorReviewIssue[]
): PriorReviewIssue[] {
  const seen = new Set<string>();
  const out: PriorReviewIssue[] = [];
  for (const issue of [...primary, ...secondary]) {
    const normalizedTitle = normalizeIssueTitle(issue.title);
    const key = `${issue.path}|${issue.line ?? ""}|${normalizedTitle || issue.body.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

const UNRESOLVED_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          diffSide
          comments(first: 1) {
            nodes { databaseId author { login } path line originalLine body }
          }
        }
      }
    }
  }
}`;

/** Root comments of hq-jr's unresolved review threads, or null when GraphQL is unavailable. */
async function getUnresolvedHqJrThreadIssues(
  octokit: any,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PriorReviewIssue[] | null> {
  if (typeof octokit.graphql !== "function") return null;
  const issues: PriorReviewIssue[] = [];
  let cursor: string | null = null;
  try {
    do {
      const data: any = await octokit.graphql(UNRESOLVED_THREADS_QUERY, { owner, repo, number: pullNumber, cursor });
      const threads = data?.repository?.pullRequest?.reviewThreads;
      if (!threads || !Array.isArray(threads.nodes) || !threads.pageInfo) {
        return null;
      }
      for (const thread of threads.nodes) {
        if (!thread || thread.isResolved) continue;
        const root = thread.comments?.nodes?.[0];
        if (!root || !isHqJrLogin(root.author?.login)) continue;
        const titleMatch = (root.body || "").match(/###\s*\[([^\]]+)\]\s*(.+)/);
        issues.push({
          id: root.databaseId,
          path: root.path,
          line: root.line ?? root.originalLine ?? undefined,
          side: thread.diffSide === "LEFT" ? "LEFT" : "RIGHT",
          title: titleMatch ? scrubIssueBody(`[${titleMatch[1]}] ${titleMatch[2]}`) : undefined,
          body: scrubIssueBody(root.body || ""),
        });
      }
      cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
    } while (cursor);
  } catch {
    return null;
  }
  return issues;
}

/**
 * Fetches prior review context for a PR.
 * Open issues are hq-jr's unresolved review threads. When thread state is unavailable,
 * falls back to SQLite findings merged with the latest hq-jr review comments.
 */
export async function getPreviousReviewContext(params: {
  octokit: any;
  owner: string;
  repo: string;
  pullNumber: number;
  currentHeadSha?: string;
  dbInstance?: import("better-sqlite3").Database;
}): Promise<PreviousReviewContext | null> {
  const { octokit, owner, repo, pullNumber, currentHeadSha, dbInstance } = params;

  let sqliteIssues: PriorReviewIssue[] = [];
  let sqliteLastSha = "";
  try {
    const rows = getReviewFindingsForPull(
      {
        owner,
        repo,
        pullNumber,
        excludeHeadSha: currentHeadSha,
      },
      dbInstance
    );
    sqliteIssues = rows.map((r, idx) => findingToIssue(r, 10_000 + idx));
    if (rows.length > 0) {
      sqliteLastSha = rows[rows.length - 1].headSha;
    }
  } catch {
    // SQLite optional; fall through to GitHub.
  }

  let githubContext: PreviousReviewContext | null = null;
  try {
    const { data: reviews } = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 50,
    });

    if (reviews && reviews.length > 0) {
      // Only hq-jr bot reviews (do not treat github-actions as prior memory).
      const botReviews = reviews.filter((r: any) => {
        const login = r.user?.login || "";
        const isBotType = r.user?.type === "Bot" || login.endsWith("[bot]");
        return isBotType && isHqJrLogin(login);
      });

      if (botReviews.length > 0) {
        const latestReview = botReviews[botReviews.length - 1];
        const { data: comments } = await octokit.pulls.listCommentsForReview({
          owner,
          repo,
          pull_number: pullNumber,
          review_id: latestReview.id,
        });

        const openIssues: PriorReviewIssue[] = (comments || []).map((c: any) => {
          const titleMatch = c.body.match(/###\s*\[([^\]]+)\]\s*(.+)/);
          const title = titleMatch ? `[${titleMatch[1]}] ${titleMatch[2]}` : undefined;
          return {
            id: c.id,
            path: c.path,
            line: c.line ?? c.original_line,
            side: (c.side as "RIGHT" | "LEFT") || "RIGHT",
            title: title ? scrubIssueBody(title) : undefined,
            body: scrubIssueBody(c.body || ""),
          };
        });

        githubContext = {
          reviewId: latestReview.id,
          lastCommitSha: latestReview.commit_id,
          verdict: latestReview.state,
          summary: scrubIssueBody(latestReview.body || ""),
          openIssues,
          source: "github",
        };
      }
    }
  } catch {
    // If review list fails or insufficient permissions, degrade gracefully.
  }

  const threadIssues = await getUnresolvedHqJrThreadIssues(octokit, owner, repo, pullNumber);
  if (threadIssues) {
    if (!githubContext && threadIssues.length === 0) return null;
    return {
      reviewId: githubContext?.reviewId ?? 0,
      lastCommitSha: githubContext?.lastCommitSha || sqliteLastSha || currentHeadSha || "unknown",
      verdict: githubContext?.verdict ?? "COMMENT",
      summary: githubContext?.summary ?? "",
      openIssues: threadIssues,
      source: "github",
    };
  }

  if (sqliteIssues.length === 0 && !githubContext) {
    return null;
  }

  if (sqliteIssues.length > 0 && githubContext) {
    return {
      reviewId: githubContext.reviewId,
      // Prefer fresher GitHub review SHA; SQLite findings may be from older heads.
      lastCommitSha: githubContext.lastCommitSha || sqliteLastSha,
      verdict: githubContext.verdict,
      summary: githubContext.summary,
      // Prefer fresher GitHub review comments; SQLite fills gaps from earlier SHAs.
      openIssues: mergeIssues(githubContext.openIssues, sqliteIssues),
      source: "merged",
    };
  }

  if (sqliteIssues.length > 0) {
    return {
      reviewId: 0,
      lastCommitSha: sqliteLastSha || currentHeadSha || "unknown",
      verdict: "COMMENT",
      summary: "Prior findings loaded from SQLite review memory.",
      openIssues: mergeIssues(sqliteIssues, []),
      source: "sqlite",
    };
  }

  return githubContext;
}

/**
 * Reconstructs the complete chronological multi-turn comment thread
 * for an inline review comment.
 */
export async function getReviewCommentThread(params: {
  octokit: any;
  owner: string;
  repo: string;
  pullNumber: number;
  commentId: number;
  inReplyToId?: number;
}): Promise<ThreadTurn[]> {
  const { octokit, owner, repo, pullNumber, commentId, inReplyToId } = params;

  try {
    const allComments =
      typeof octokit.paginate === "function"
        ? await octokit.paginate(octokit.pulls.listReviewComments, {
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 100,
          })
        : (
            await octokit.pulls.listReviewComments({
              owner,
              repo,
              pull_number: pullNumber,
              per_page: 100,
            })
          ).data;

    const rootId = inReplyToId || commentId;

    const threadComments = (allComments || []).filter((c: any) => {
      return c.id === rootId || c.in_reply_to_id === rootId;
    });

    threadComments.sort(
      (a: any, b: any) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    return threadComments.map((c: any) => ({
      id: c.id,
      author: c.user?.login || "unknown",
      body: c.body || "",
      createdAt: c.created_at,
      isBot: c.user?.type === "Bot" || (c.user?.login || "").endsWith("[bot]"),
    }));
  } catch {
    return [];
  }
}
