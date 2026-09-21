import { scrubSecrets } from "./scrubber.js";
import {
  getReviewFindingsForPull,
  type ReviewFindingRow,
} from "./db.js";

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

/**
 * Deduplicate issues by path+line+title key, preferring earlier (SQLite) entries.
 */
function mergeIssues(
  primary: PriorReviewIssue[],
  secondary: PriorReviewIssue[]
): PriorReviewIssue[] {
  const seen = new Set<string>();
  const out: PriorReviewIssue[] = [];
  for (const issue of [...primary, ...secondary]) {
    const key = `${issue.path}|${issue.line ?? ""}|${issue.title ?? issue.body.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/**
 * Fetches prior review context for a PR.
 * Prefers SQLite findings from earlier head SHAs for continuity across pushes,
 * then supplements with the latest hq-jr GitHub review comments.
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
        return isBotType && login.includes("hq-jr");
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

  if (sqliteIssues.length === 0 && !githubContext) {
    return null;
  }

  if (sqliteIssues.length > 0 && githubContext) {
    return {
      reviewId: githubContext.reviewId,
      lastCommitSha: sqliteLastSha || githubContext.lastCommitSha,
      verdict: githubContext.verdict,
      summary: githubContext.summary,
      openIssues: mergeIssues(sqliteIssues, githubContext.openIssues),
      source: "merged",
    };
  }

  if (sqliteIssues.length > 0) {
    return {
      reviewId: 0,
      lastCommitSha: sqliteLastSha || currentHeadSha || "unknown",
      verdict: "COMMENT",
      summary: "Prior findings loaded from SQLite review memory.",
      openIssues: sqliteIssues,
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
