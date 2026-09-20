
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
}

export interface ThreadTurn {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  isBot: boolean;
}

/**
 * Fetches the most recent review submitted by hq-jr for this PR,
 * along with its inline comments to track previous findings.
 */
export async function getPreviousReviewContext(params: {
  octokit: any;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<PreviousReviewContext | null> {
  const { octokit, owner, repo, pullNumber } = params;

  try {
    const { data: reviews } = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 50,
    });

    if (!reviews || reviews.length === 0) {
      return null;
    }

    // Filter reviews created by hq-jr bot
    const botReviews = reviews.filter((r: any) => {
      const login = r.user?.login || "";
      const isBotType = r.user?.type === "Bot" || login.endsWith("[bot]");
      return isBotType && (login.includes("hq-jr") || login.includes("github-actions"));
    });

    if (botReviews.length === 0) {
      return null;
    }

    // Pick the most recent bot review
    const latestReview = botReviews[botReviews.length - 1];

    // Fetch inline comments associated with that review
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
        title,
        body: c.body,
      };
    });

    return {
      reviewId: latestReview.id,
      lastCommitSha: latestReview.commit_id,
      verdict: latestReview.state,
      summary: latestReview.body || "",
      openIssues,
    };
  } catch (err) {
    // If review list fails or insufficient permissions, degrade gracefully
    return null;
  }
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
    const allComments = typeof octokit.paginate === "function"
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

    // Find all comments belonging to this thread
    const threadComments = (allComments || []).filter((c: any) => {
      return c.id === rootId || c.in_reply_to_id === rootId;
    });

    // Sort chronologically
    threadComments.sort(
      (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
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
