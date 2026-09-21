import { Probot } from "probot";
import { checkAiHealth, runTriage, runDeepReview } from "./services/ai.js";
import { parseUnifiedDiff, isLineInDiff, DiffFile } from "./services/diff-parser.js";
import { packageReviewContext } from "./services/context-packager.js";
import { replyToDiscussion } from "./services/discussion.js";
import { getPreviousReviewContext, getReviewCommentThread } from "./services/review-memory.js";
import { executeRemediation } from "./services/remediation.js";
import { scrubSecrets } from "./services/scrubber.js";
import { addRemediationCommit, hasRemediationCommit, acquireRunLock, releaseRunLock, saveReviewFindings, getSandboxJobByCheckRun } from "./services/db.js";
import { executeSandboxCheckRun } from "./services/sandbox-runner.js";
import type { SandboxProbeRequest } from "./schemas/review.js";

/** Remediation only on explicit @hq-jr fix|patch|remediate (optional and merge). */

/** True when path is a file under tests/ (not bare tests, not traversal). */
export function isSafeReproTestPath(path: string | undefined | null): boolean {
  const normalized = (path ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  return (
    normalized.startsWith("tests/") &&
    normalized.length > "tests/".length &&
    !normalized.includes("..") &&
    !normalized.endsWith("/")
  );
}

export const REMEDIATE_COMMAND_RE =
  /@hq-jr(?:\[bot\])?\s+(fix|patch|remediate)(\s+and\s+merge)?\b/i;
export const COMMIT_REPRO_COMMAND_RE = /@hq-jr(?:\[bot\])?\s+commit-repro\b/i;


export default (app: Probot, { getRouter }: { getRouter?: (path?: string) => any } = {}) => {
  async function resolveInstallationToken(octokit: any): Promise<string | undefined> {
    try {
      if (typeof octokit.auth !== "function") return undefined;
      const authResult = await octokit.auth({ type: "installation" });
      const token = authResult?.token;
      return typeof token === "string" && token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  }

  async function commitReproTestFromSummary(params: {
    octokit: any;
    owner: string;
    repoName: string;
    pullNumber: number;
    sender: string;
    summaryText: string;
    headSha: string;
    targetBranch: string;
  }): Promise<{ ok: boolean; message: string }> {
    const { octokit, owner, repoName, pullNumber, sender, summaryText, headSha, targetBranch } = params;

    // Fail closed on fork PRs: never updateRef into a head that is not this repo.
    try {
      const { data: prMeta } = await octokit.pulls.get({
        owner,
        repo: repoName,
        pull_number: pullNumber,
      });
      const headFullName = prMeta?.head?.repo?.full_name as string | undefined;
      const expected = `${owner}/${repoName}`;
      if (!headFullName || headFullName !== expected) {
        return {
          ok: false,
          message:
            `⚠️ **hq-jr** refuses to commit a reproduction test on fork PR heads ` +
            `(head repo: \`${headFullName || "unknown"}\`, expected \`${expected}\`). ` +
            `Open the PR from a branch in this repository or push the test manually.`,
        };
      }
    } catch (forkErr: unknown) {
      const msg = forkErr instanceof Error ? forkErr.message : String(forkErr);
      return {
        ok: false,
        message: `⚠️ **hq-jr** could not verify PR head repository before commit-repro: ${msg}`,
      };
    }

    // Prefer the synthesized-test section (heading + optional path in parentheses + fence).
    const sectionMatch = summaryText.match(
      /###\s*Synthesized Reproduction Test(?:\s*\(([^)]+)\))?[\s\S]*?```(?:rust|typescript|javascript|python|go)?\s*([\s\S]*?)```/i
    );
    const extractedPath = sectionMatch?.[1]?.trim() || undefined;
    const testCode = sectionMatch?.[2]?.trim()
      || summaryText.match(/```(?:rust|typescript|javascript|python|go)?\s*([\s\S]*?)```/)?.[1]?.trim()
      || null;

    if (!testCode) {
      return {
        ok: false,
        message: `⚠️ **hq-jr** could not extract a synthesized reproduction test from this check run output.`,
      };
    }

    let testFileName: string;
    const normalizedExtracted = extractedPath?.replace(/^\/+/, "").replace(/\/+$/, "") ?? "";
    const safeExtractedPath = isSafeReproTestPath(normalizedExtracted)
      ? normalizedExtracted
      : null;
    if (safeExtractedPath) {
      testFileName = safeExtractedPath;
    } else {
      const isRust = summaryText.includes("cargo") || summaryText.includes(".rs") || /\brust\b/i.test(summaryText);
      const isPython = summaryText.includes("pytest") || summaryText.includes(".py");
      const isGo = summaryText.includes("go test") || summaryText.includes(".go");
      testFileName = isRust
        ? `tests/repro_issue_${pullNumber}.rs`
        : isPython
          ? `tests/test_repro_issue_${pullNumber}.py`
          : isGo
            ? `tests/repro_issue_${pullNumber}_test.go`
            : `tests/repro_issue_${pullNumber}.test.ts`;
    }

    const { data: blob } = await octokit.git.createBlob({
      owner,
      repo: repoName,
      content: Buffer.from(testCode).toString("base64"),
      encoding: "base64",
    });

    const { data: baseCommit } = await octokit.git.getCommit({
      owner,
      repo: repoName,
      commit_sha: headSha,
    });

    const { data: newTree } = await octokit.git.createTree({
      owner,
      repo: repoName,
      base_tree: baseCommit.tree.sha,
      tree: [
        {
          path: testFileName,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        },
      ],
    });

    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo: repoName,
      message: `test: add synthesized adversarial reproduction test for PR #${pullNumber} [skip ci]`,
      tree: newTree.sha,
      parents: [headSha],
    });

    addRemediationCommit(newCommit.sha);

    await octokit.git.updateRef({
      owner,
      repo: repoName,
      ref: `heads/${targetBranch}`,
      sha: newCommit.sha,
    });

    return {
      ok: true,
      message: `✅ **Reproduction Test Committed:** \`${testFileName}\` has been committed directly to branch \`${targetBranch}\` (Commit: \`${newCommit.sha.slice(0, 7)}\`) by @${sender}.`,
    };
  }

  process.on("unhandledRejection", (reason) => {
    app.log.warn({ reason }, "Handled unhandledRejection to ensure daemon stability");
  });

  process.on("uncaughtException", (error) => {
    app.log.error({ error }, "Fatal uncaughtException in worker process");
  });

  app.log.info("hq-jr code reviewer initialized with Vertex AI ADC");

  // Expose health check endpoint on the Probot Express router
  if (getRouter) {
    const router = getRouter();
    router.get("/healthz", async (_req: any, res: any) => {
      const aiHealth = await checkAiHealth();
      const healthy = aiHealth.status === "ok";
      res.status(healthy ? 200 : 503).json({
        status: healthy ? "healthy" : "unhealthy",
        uptimeSeconds: process.uptime(),
        vertexAi: aiHealth,
      });
    });
  }


  async function runPullRequestReview(params: {
    octokit: any;
    owner: string;
    repoName: string;
    pullNumber: number;
    pr: {
      head: { sha: string; ref?: string };
      title: string;
      body?: string | null;
      user?: { login: string } | null;
      state?: string;
      merged?: boolean | null;
      merged_at?: string | null;
    };
  }) {
    const { octokit, owner, repoName, pullNumber, pr } = params;

    // Do not review PRs that are already closed or merged
    if (pr.state === "closed" || pr.merged || pr.merged_at) {
      app.log.info({ pullNumber }, "PR is closed or already merged. Skipping review.");
      return;
    }

    // Do not review commits created by hq-jr autonomous remediation
    if (hasRemediationCommit(pr.head.sha)) {
      app.log.info({ pullNumber, sha: pr.head.sha }, "Commit was generated by hq-jr remediation. Skipping self-review.");
      return;
    }

    const runKey = `${owner}/${repoName}#${pullNumber}`;
    const acquired = acquireRunLock({
      runKey,
      owner,
      repo: repoName,
      pullNumber,
      headSha: pr.head.sha,
    });
    if (!acquired) {
      app.log.warn({ runKey, headSha: pr.head.sha }, "Review run already active for pull request. Skipping duplicate event.");
      return;
    }

    app.log.info({ pullNumber, repo: `${owner}/${repoName}` }, "Starting automated code review");

    let checkRun: any = null;

    try {
      // 1. Create or update Check Run: in_progress
      try {
        checkRun = await octokit.checks.create({
          owner,
          repo: repoName,
          name: "hq-jr AI Code Review",
          head_sha: pr.head.sha,
          status: "in_progress",
          started_at: new Date().toISOString(),
          output: {
            title: "Analyzing Pull Request",
            summary: "Fetching pull request diff and performing Tier 1 triage...",
          },
        });
      } catch (checkErr) {
        app.log.warn({ checkErr }, "Failed to create GitHub check run, proceeding with review");
      }

      // 2. Fetch PR diff
      const diffResponse = await octokit.pulls.get({
        owner,
        repo: repoName,
        pull_number: pullNumber,
        mediaType: {
          format: "diff",
        },
      });

      // 3. Parse diff and build context package
      const diffText = diffResponse.data as unknown as string;
      const parsedDiff = parseUnifiedDiff(diffText);
      const totalHunks = parsedDiff.files.reduce((sum, f) => sum + f.hunks.length, 0);

      if (parsedDiff.files.length === 0 || totalHunks === 0) {
        if (checkRun?.data?.id) {
          await octokit.checks.update({
            owner,
            repo: repoName,
            check_run_id: checkRun.data.id,
            status: "completed",
            conclusion: "neutral",
            output: {
              title: "No Code Changes Detected",
              summary: "Pull request contains no textual diff or code hunks to analyze (e.g. pure file mode changes or binary assets).",
            },
          });
        }
        return;
      }

      const contextPackage = packageReviewContext(parsedDiff);
      if (contextPackage.itemsToReview.length === 0) {
        app.log.info({ pullNumber }, "All modified files excluded by noise filters. Bypassing review.");
        if (checkRun?.data?.id) {
          await octokit.checks.update({
            owner,
            repo: repoName,
            check_run_id: checkRun.data.id,
            status: "completed",
            conclusion: "success",
            output: {
              title: "Triage Passed: Excluded Files Only",
              summary: `Modified files were identified as non-reviewable artifacts (lockfiles, documentation, generated bundles):\n\n${contextPackage.ignoredItems.map((i: any) => `- \`${i.path}\`: ${i.reason}`).join("\n")}`,
            },
          });
        }
        return;
      }

      // 4. Tier 1: Triage with Gemini 3.8 Flash
      app.log.info({ pullNumber, filesCount: contextPackage.itemsToReview.length }, "Executing Tier 1 triage");
      const triage = await runTriage(contextPackage.promptPayload);

      const filesToReview = triage.files.filter((f) => f.shouldReview);
      if (filesToReview.length === 0) {
        app.log.info({ pullNumber }, "All files classified as low risk. Review complete.");
        if (checkRun?.data?.id) {
          await octokit.checks.update({
            owner,
            repo: repoName,
            check_run_id: checkRun.data.id,
            status: "completed",
            conclusion: "success",
            output: {
              title: "Triage Passed: Low Risk Changes",
              summary: `### Review Summary\n\n${triage.summary}\n\nAll modified files are low risk or auto-generated. Deep review bypassed.`,
            },
          });
        }
        return;
      }

      // 5. Tier 2: Deep Semantic Analysis with Gemini 3.8 Flash (High Thinking)
      app.log.info({ pullNumber, count: filesToReview.length }, "Executing Tier 2 deep review");

      // Retrieve previous review memory if hq-jr has audited this PR before
      const previousReview = await getPreviousReviewContext({
        octokit,
        owner,
        repo: repoName,
        pullNumber,
        currentHeadSha: pr.head.sha,
      });

      if (previousReview) {
        app.log.info(
          {
            pullNumber,
            prevReviewId: previousReview.reviewId,
            prevCommitSha: previousReview.lastCommitSha.slice(0, 7),
            openIssuesCount: previousReview.openIssues.length,
          },
          "Incorporating prior review context for incremental verification"
        );
      }

      const reviewPrompt = `Pull Request: #${pullNumber} - ${pr.title}
Author: ${pr.user?.login}
Description:
${pr.body || "No description provided."}

Files requiring deep review:
${filesToReview.map((f) => `- ${f.path} (Risk: ${f.risk}, Reason: ${f.reason})`).join("\n")}

${contextPackage.promptPayload}
`;

      const review = await runDeepReview(reviewPrompt, { previousReview });

      // 6. Post inline review comments via Octokit REST (with line anchor validation)
      const normalizePath = (p: string) => p.replace(/^[./]+/, "").replace(/\\/g, "/");
      const fileMap = new Map<string, DiffFile>();
      for (const f of parsedDiff.files) {
        if (f.newPath) fileMap.set(normalizePath(f.newPath), f);
        if (f.oldPath) fileMap.set(normalizePath(f.oldPath), f);
      }

      const validComments: { path: string; line: number; side: "RIGHT" | "LEFT"; body: string }[] = [];
      const orphanComments: string[] = [];

      for (const c of review.comments) {
        const normPath = normalizePath(c.path);
        let body = `### [${c.category}] ${c.title}\n\n${c.body}`;
        if (c.suggestedPatch) {
          body += `\n\n\`\`\`suggestion\n${c.suggestedPatch}\n\`\`\``;
        }

        const matchedFile = fileMap.get(normPath);
        const effectiveSide = matchedFile?.isDeleted ? "LEFT" : c.side;
        if (
          matchedFile &&
          !matchedFile.isSubmodule &&
          !matchedFile.isBinary &&
          isLineInDiff(matchedFile, c.line, effectiveSide)
        ) {
          validComments.push({
            path: matchedFile.newPath || matchedFile.oldPath,
            line: c.line,
            side: effectiveSide,
            body,
          });
        } else {
          let orphanBody = `- **${normPath}:${c.line}** [${c.severity}]: ${c.title}\n  ${c.body}`;
          if (c.suggestedPatch) {
            orphanBody += `\n  \`\`\`\n  ${c.suggestedPatch}\n  \`\`\``;
          }
          orphanComments.push(orphanBody);
        }
      }

      let reviewBody = `## hq-jr Automated Code Review\n\n${review.summary}\n\n**Verdict:** \`${review.verdict}\``;

      if (review.resolvedPriorIssues && review.resolvedPriorIssues.length > 0) {
        reviewBody += `\n\n### ✅ Resolved Issues from Prior Review\n${review.resolvedPriorIssues.map((i) => `- ${i}`).join("\n")}`;
      }

      if (review.unresolvedPriorIssues && review.unresolvedPriorIssues.length > 0) {
        reviewBody += `\n\n### ⚠️ Remaining Open Issues from Prior Review\n${review.unresolvedPriorIssues.map((i) => `- ${i}`).join("\n")}`;
      }

      if (orphanComments.length > 0) {
        reviewBody += `\n\n### Additional File Observations (Outside Modified Diff Lines)\n${orphanComments.join("\n")}`;
      }

      if (validComments.length > 0 || orphanComments.length > 0 || previousReview) {
        try {
          await octokit.pulls.createReview({
            owner,
            repo: repoName,
            pull_number: pullNumber,
            commit_id: pr.head.sha,
            event: review.verdict === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "COMMENT",
            body: reviewBody,
            comments: validComments,
          });
        } catch (reviewErr: any) {
          if (reviewErr?.status === 422 && validComments.length > 0) {
            app.log.warn(
              { reviewErr: reviewErr.message },
              "Inline comment position rejected by GitHub (HTTP 422). Falling back to review summary."
            );
            let fallbackBody = reviewBody + "\n\n### Inline Comments (Attached as Summary due to diff positioning):\n";
            for (const vc of validComments) {
              fallbackBody += `\n- **${vc.path}:${vc.line}** (${vc.side}):\n${vc.body}\n`;
            }
            await octokit.pulls.createReview({
              owner,
              repo: repoName,
              pull_number: pullNumber,
              commit_id: pr.head.sha,
              event: review.verdict === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "COMMENT",
              body: fallbackBody,
            });
          } else {
            throw reviewErr;
          }
        }
      }


      // Persist review findings to SQLite for cross-push memory
      try {
        const findingRows = review.comments.map((c) => ({
          owner,
          repo: repoName,
          pullNumber,
          headSha: pr.head.sha,
          path: c.path,
          line: c.line,
          side: c.side,
          severity: c.severity,
          title: c.title,
          body: c.body,
        }));
        if (findingRows.length > 0) {
          saveReviewFindings(findingRows);
        }
      } catch (persistErr) {
        app.log.warn({ persistErr, pullNumber }, "Failed to persist review findings to SQLite");
      }

      // 7. Complete Check Run
      if (checkRun?.data?.id) {
        const conclusion =
          review.verdict === "REQUEST_CHANGES"
            ? "failure"
            : review.verdict === "APPROVE"
              ? "success"
              : "neutral";

        await octokit.checks.update({
          owner,
          repo: repoName,
          check_run_id: checkRun.data.id,
          status: "completed",
          conclusion,
          output: {
            title: `Review Completed: ${review.verdict}`,
            summary: `### Summary\n\n${review.summary}\n\nFound **${review.comments.length}** observation(s).`,
          },
        });
      }

      // 8. Tier 3: Trigger asynchronous sandbox check run if requested by deep review
      if (review.requiresSandboxVerification) {
        const goal = review.verificationGoal || "Verify flagged critical issues in isolated container sandbox";
        app.log.info({ pullNumber, goal }, "Triggering Tier 3 asynchronous sandbox check run");
        const authToken = await resolveInstallationToken(octokit);
        executeSandboxCheckRun({
          octokit,
          owner,
          repo: repoName,
          pullNumber,
          headSha: pr.head.sha,
          branch: pr.head.ref || "main",
          verificationGoal: goal,
          modifiedFiles: parsedDiff.files.map((f) => f.newPath || f.oldPath),
          probes: review.sandboxProbes,
          authToken,
        }).catch((sandboxErr: unknown) => {
          app.log.warn({ sandboxErr, pullNumber }, "Async sandbox verification check run encountered error");
        });
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      app.log.error({ err, pullNumber }, "Error processing review");
      if (checkRun?.data?.id) {
        try {
          await octokit.checks.update({
            owner,
            repo: repoName,
            check_run_id: checkRun.data.id,
            status: "completed",
            conclusion: "failure",
            output: {
              title: "Review Failed",
              summary: `Automated review encountered an error: ${errorMsg}`,
            },
          });
        } catch (updateErr) {
          app.log.warn({ updateErr }, "Failed to update check run conclusion on error");
        }
      }
    } finally {
      releaseRunLock(runKey);
    }
  }

  // Handle pull request events
  app.on(
    ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"],
    async (context) => {
      const { pull_request: pr, repository: repo, sender } = context.payload;

      // 1. Never review PR actions triggered by the bot itself or other automated systems
      if (
        sender?.type === "Bot" ||
        sender?.login?.includes("hq-jr") ||
        sender?.login?.endsWith("[bot]")
      ) {
        app.log.info(
          { pullNumber: pr.number, sender: sender?.login },
          "Ignoring pull_request event triggered by bot self-action"
        );
        return;
      }

      // 2. Never review PRs that are already merged or closed
      if (pr.state === "closed" || pr.merged || (pr as any).merged_at) {
        app.log.info(
          { pullNumber: pr.number },
          "Ignoring pull_request event for closed or merged pull request"
        );
        return;
      }

      // 3. Never review commits generated by hq-jr autonomous remediation
      if (hasRemediationCommit(pr.head.sha)) {
        app.log.info(
          { pullNumber: pr.number, sha: pr.head.sha },
          "Ignoring pull_request event for hq-jr remediation commit"
        );
        return;
      }

      await runPullRequestReview({
        octokit: context.octokit,
        owner: repo.owner.login,
        repoName: repo.name,
        pullNumber: pr.number,
        pr,
      });
    }
  );

  // Handle interactive developer discussions and @hq-jr mentions
  app.on("pull_request_review_comment.created", async (context) => {
    const comment = context.payload.comment;
    const user = comment.user;

    // Do not respond to self or other bot comments
    if (user.type === "Bot" || user.login.endsWith("[bot]")) {
      return;
    }

    const body = comment.body.trim();
    const mentionsBot = body.includes("@hq-jr") || body.includes("@hq-jr[bot]");
    const isReply = Boolean(comment.in_reply_to_id);

    if (!mentionsBot && !isReply) {
      return;
    }

    try {
      const threadHistory = await getReviewCommentThread({
        octokit: context.octokit,
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        pullNumber: context.payload.pull_request.number,
        commentId: comment.id,
        inReplyToId: comment.in_reply_to_id,
      });

      // Avoid thread hijacking: if not explicitly mentioned, only respond if hq-jr is an existing participant in thread
      if (!mentionsBot && isReply) {
        const involvesBot = threadHistory.some((t) => t.isBot || t.author.includes("hq-jr"));
        if (!involvesBot) {
          return;
        }
      }

      let originalComment: string | undefined;
      if (threadHistory.length > 0) {
        originalComment = threadHistory[0].body;
      } else if (comment.in_reply_to_id) {
        const parent = await context.octokit.pulls.getReviewComment({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          comment_id: comment.in_reply_to_id,
        });
        originalComment = parent.data.body;
      }

      app.log.info(
        { commentId: comment.id, user: user.login, threadTurns: threadHistory.length },
        "Responding to discussion comment with full thread context"
      );
      const reply = await replyToDiscussion({
        filePath: comment.path,
        diffHunk: comment.diff_hunk,
        originalComment,
        threadHistory,
        userQuery: body,
        authorLogin: user.login,
        commitSha: comment.commit_id,
      });

      await context.octokit.pulls.createReplyForReviewComment({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        pull_number: context.payload.pull_request.number,
        comment_id: comment.id,
        body: reply,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      app.log.error({ err, commentId: comment.id }, "Failed to reply to discussion comment");
      await context.octokit.pulls.createReplyForReviewComment({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        pull_number: context.payload.pull_request.number,
        comment_id: comment.id,
        body: `*hq-jr encountered an issue analyzing this thread: ${errorMsg}*`,
      });
    }
  });

  // Handle PR conversation comments mentioning @hq-jr
  app.on("issue_comment.created", async (context) => {
    // Only handle comments on pull requests
    if (!context.payload.issue.pull_request) {
      return;
    }

    const comment = context.payload.comment;
    const user = comment.user;

    // Do not respond to self or other bot comments
    if (user.type === "Bot" || user.login.endsWith("[bot]")) {
      return;
    }

    const body = comment.body.trim();
    const mentionsBot = body.includes("@hq-jr") || body.includes("@hq-jr[bot]");
    if (!mentionsBot) {
      return;
    }

    const owner = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;
    const pullNumber = context.payload.issue.number;

    app.log.info({ pullNumber, user: user.login }, "Responding to main PR thread comment mentioning @hq-jr");

    try {
      const lower = body.toLowerCase();
      const remediateMatch = body.match(REMEDIATE_COMMAND_RE);
      const isRemediateCommand = Boolean(remediateMatch);

      if (isRemediateCommand) {
        // Enforce RBAC: Verify commenter has write or admin permissions to repo
        let hasWrite = false;
        try {
          const { data: perm } = await context.octokit.repos.getCollaboratorPermissionLevel({
            owner,
            repo: repoName,
            username: user.login,
          });
          hasWrite = perm.permission === "admin" || perm.permission === "write";
        } catch (permErr) {
          app.log.warn({ permErr, user: user.login }, "Failed to verify collaborator permissions; failing closed");
        }

        if (!hasWrite) {
          await context.octokit.issues.createComment({
            owner,
            repo: repoName,
            issue_number: pullNumber,
            body: `⛔ **Access Denied:** Only repository collaborators with write or admin permissions can trigger automated remediation or merging.`,
          });
          return;
        }

        app.log.info({ pullNumber, user: user.login }, "Triggering autonomous remediation from comment");
        await context.octokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: pullNumber,
          body: `🛠️ **hq-jr** received remediation request from @${user.login}. Fetching prior audit findings, synthesizing code fixes with High Thinking, and generating remediation branch/commit...`,
        });

        const prResponse = await context.octokit.pulls.get({
          owner,
          repo: repoName,
          pull_number: pullNumber,
        });

        const prevReview = await getPreviousReviewContext({
          octokit: context.octokit,
          owner,
          repo: repoName,
          pullNumber,
          currentHeadSha: prResponse.data.head.sha,
        });

        if (!prevReview || prevReview.openIssues.length === 0) {
          await context.octokit.issues.createComment({
            owner,
            repo: repoName,
            issue_number: pullNumber,
            body: `⚠️ **hq-jr** could not find any open review issues to remediate. Run \`@hq-jr review\` first to audit the PR.`,
          });
          return;
        }

        const hasNegativeMerge = /\b(?:do not|don't|no|never)\s+merge\b/i.test(body);
        const hasExplicitMergeCommand =
          Boolean(remediateMatch?.[2]) || /\b(?:and\s+merge|auto-?merge)\b/i.test(body);
        const autoMerge = hasExplicitMergeCommand && !hasNegativeMerge;
        const result = await executeRemediation({
          octokit: context.octokit,
          owner,
          repo: repoName,
          pullNumber,
          pr: prResponse.data,
          issues: prevReview.openIssues,
          autoMerge,
        });

        let commentBody = `### 🛠️ hq-jr Remediation Report\n\n${result.message}\n\n`;
        if (result.filesModified.length > 0) {
          commentBody += `**Files Modified:**\n${result.filesModified.map((f) => `- \`${f}\``).join("\n")}\n\n`;
        }
        if (result.commitSha) {
          addRemediationCommit(result.commitSha);
          commentBody += `**Commit SHA:** \`${result.commitSha.slice(0, 7)}\`\n`;
        }
        if (result.prUrl) {
          commentBody += `**Remediation PR:** ${result.prUrl}\n`;
        }

        await context.octokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: pullNumber,
          body: commentBody,
        });
        return;
      }

      if (COMMIT_REPRO_COMMAND_RE.test(body)) {
        let hasWrite = false;
        try {
          const { data: perm } = await context.octokit.repos.getCollaboratorPermissionLevel({
            owner,
            repo: repoName,
            username: user.login,
          });
          hasWrite = perm.permission === "admin" || perm.permission === "write";
        } catch (permErr) {
          app.log.warn({ permErr, user: user.login }, "Failed to verify collaborator permissions for commit-repro; failing closed");
        }

        if (!hasWrite) {
          await context.octokit.issues.createComment({
            owner,
            repo: repoName,
            issue_number: pullNumber,
            body: `⛔ **Access Denied:** Only repository collaborators with write or admin permissions can commit reproduction tests.`,
          });
          return;
        }

        const prResponse = await context.octokit.pulls.get({
          owner,
          repo: repoName,
          pull_number: pullNumber,
        });
        const pr = prResponse.data;

        let summaryText = "";
        try {
          const checks = await context.octokit.checks.listForRef({
            owner,
            repo: repoName,
            ref: pr.head.sha,
            check_name: "hq-jr AI Sandbox Verification",
            per_page: 10,
          });
          const latest = (checks.data.check_runs || [])[0];
          summaryText = latest?.output?.summary || "";
        } catch (checkErr) {
          app.log.warn({ checkErr }, "Could not list sandbox check runs for commit-repro");
        }

        const result = await commitReproTestFromSummary({
          octokit: context.octokit,
          owner,
          repoName,
          pullNumber,
          sender: user.login,
          summaryText,
          headSha: pr.head.sha,
          targetBranch: pr.head.ref,
        });

        await context.octokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: pullNumber,
          body: result.message,
        });
        return;
      }

            const isReviewCommand =
        lower.includes("review") ||
        lower.includes("audit") ||
        lower.includes("scan") ||
        lower.includes("diff");

      if (isReviewCommand) {
        app.log.info({ pullNumber, user: user.login }, "Triggering full PR review from comment command");
        await context.octokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: pullNumber,
          body: `🤖 **hq-jr** received review command from @${user.login}. Starting automated code review with High Thinking - line-by-line diff comments will appear directly under **Files changed**...`,
        });

        const prResponse = await context.octokit.pulls.get({
          owner,
          repo: repoName,
          pull_number: pullNumber,
        });

        await runPullRequestReview({
          octokit: context.octokit,
          owner,
          repoName,
          pullNumber,
          pr: prResponse.data,
        });
        return;
      }

      const hasNegativeMerge = /\b(?:do not|don't|no|never)\s+merge\b/i.test(body);
      const isMergeOnlyCommand =
        /\b(?:merge(?:\s+it|\s+this)?|auto-?merge)\b/i.test(body) &&
        !hasNegativeMerge;

      if (isMergeOnlyCommand) {
        let hasWrite = false;
        try {
          const { data: perm } = await context.octokit.repos.getCollaboratorPermissionLevel({
            owner,
            repo: repoName,
            username: user.login,
          });
          hasWrite = perm.permission === "admin" || perm.permission === "write";
        } catch (permErr: unknown) {
          app.log.warn({ permErr, user: user.login }, "Failed to verify collaborator permissions for merge; failing closed");
        }

        if (!hasWrite) {
          await context.octokit.issues.createComment({
            owner,
            repo: repoName,
            issue_number: pullNumber,
            body: `⛔ **Access Denied:** Only repository collaborators with write or admin permissions can merge pull requests.`,
          });
          return;
        }

        const prResponse = await context.octokit.pulls.get({
          owner,
          repo: repoName,
          pull_number: pullNumber,
        });
        const pr = prResponse.data;

        let closedIssueNotice = "";
        if (lower.includes("close") && (lower.includes("issue") || lower.includes("it"))) {
          const issueMatch = body.match(/#(\d+)/) || (pr.body || "").match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
          if (issueMatch) {
            const linkedIssueNum = parseInt(issueMatch[1], 10);
            try {
              await context.octokit.issues.update({
                owner,
                repo: repoName,
                issue_number: linkedIssueNum,
                state: "closed",
              });
              closedIssueNotice = ` and closed linked issue #${linkedIssueNum}`;
            } catch (closeErr: unknown) {
              app.log.warn({ closeErr, linkedIssueNum }, "Could not close linked issue");
            }
          }
        }

        try {
          await context.octokit.pulls.merge({
            owner,
            repo: repoName,
            pull_number: pullNumber,
            merge_method: "squash",
          });

          await context.octokit.issues.createComment({
            owner,
            repo: repoName,
            issue_number: pullNumber,
            body: `✅ **Merged:** Successfully merged Pull Request #${pullNumber} (squash)${closedIssueNotice} upon request by @${user.login}.`,
          });
        } catch (mergeErr: unknown) {
          const errorMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
          app.log.warn({ mergeErr, pullNumber }, "Direct merge failed, attempting GraphQL auto-merge");
          try {
            const gqlResult = await context.octokit.graphql<{
              repository?: { pullRequest?: { id?: string } };
            }>(
              `query ($owner: String!, $repo: String!, $prNumber: Int!) {
                 repository(owner: $owner, name: $repo) {
                   pullRequest(number: $prNumber) {
                     id
                   }
                 }
               }`,
              { owner, repo: repoName, prNumber: pullNumber }
            );
            if (gqlResult.repository?.pullRequest?.id) {
              await context.octokit.graphql(
                `mutation ($input: EnablePullRequestAutoMergeInput!) {
                   enablePullRequestAutoMerge(input: $input) {
                     pullRequest {
                       number
                     }
                   }
                 }`,
                {
                  input: {
                    pullRequestId: gqlResult.repository.pullRequest.id,
                    mergeMethod: "SQUASH",
                  },
                }
              );
              await context.octokit.issues.createComment({
                owner,
                repo: repoName,
                issue_number: pullNumber,
                body: `🔄 **Auto-Merge Enabled:** Direct merge could not complete immediately (${errorMsg}). Auto-merge has been armed for PR #${pullNumber}${closedIssueNotice} upon request by @${user.login}.`,
              });
              return;
            }
          } catch (gqlErr: unknown) {
            app.log.warn({ gqlErr }, "GraphQL auto-merge also failed");
          }

          await context.octokit.issues.createComment({
            owner,
            repo: repoName,
            issue_number: pullNumber,
            body: `⚠️ **Merge Blocked:** Could not merge PR #${pullNumber}: ${errorMsg}. Please ensure all required check runs are passing and mergeable state is clean.`,
          });
        }
        return;
      }

      // Fetch PR diff for context
      const diffResponse = await context.octokit.pulls.get({
        owner,
        repo: repoName,
        pull_number: pullNumber,
        mediaType: {
          format: "diff",
        },
      });
      const diffText = diffResponse.data as unknown as string;

      const reply = await replyToDiscussion({
        filePath: `Pull Request #${pullNumber}`,
        diffHunk: scrubSecrets(diffText.slice(0, 15000)).scrubbed,
        userQuery: scrubSecrets(body).scrubbed,
        authorLogin: user.login,
      });

      await context.octokit.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pullNumber,
        body: reply,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      app.log.error({ err, pullNumber }, "Failed to reply to PR issue comment");
      await context.octokit.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pullNumber,
        body: `*hq-jr encountered an issue analyzing this thread: ${errorMsg}*`,
      });
    }
  });

  // Handle re-requesting review from Checks UI
  app.on("check_run.rerequested", async (context) => {
    const checkRun = context.payload.check_run;
    const pullRequests = checkRun.pull_requests;

    if (!pullRequests || pullRequests.length === 0) {
      app.log.info("No pull requests attached to re-requested check run");
      return;
    }

    const prRef = pullRequests[0];
    const owner = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;

    app.log.info(
      { pullNumber: prRef.number, checkRunId: checkRun.id },
      "Check run re-requested by developer"
    );

    const prResponse = await context.octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: prRef.number,
    });

    await runPullRequestReview({
      octokit: context.octokit,
      owner,
      repoName,
      pullNumber: prRef.number,
      pr: prResponse.data,
    });
  });

  // Handle Check Run action buttons (e.g. Commit Repro Test / Re-run Sandbox)
  app.on("check_run.requested_action", async (context) => {
    const { check_run: checkRun, requested_action: requestedAction } = context.payload;
    const identifier = requestedAction.identifier;
    const owner = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;
    const sender = context.payload.sender.login;

    const pullRequests = checkRun.pull_requests;
    if (!pullRequests || pullRequests.length === 0) {
      app.log.warn({ checkRunId: checkRun.id }, "No pull request attached to check run action");
      return;
    }
    const pullNumber = pullRequests[0].number;

    let hasWrite = false;
    try {
      const { data: perm } = await context.octokit.repos.getCollaboratorPermissionLevel({
        owner,
        repo: repoName,
        username: sender,
      });
      hasWrite = perm.permission === "admin" || perm.permission === "write";
    } catch (permErr: unknown) {
      app.log.warn({ permErr, sender }, "Failed to verify collaborator permissions for check action; failing closed");
    }

    if (!hasWrite) {
      await context.octokit.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pullNumber,
        body: `⛔ **Access Denied:** Only repository collaborators with write or admin permissions can trigger sandbox check actions.`,
      });
      return;
    }

    if (identifier === "commit_repro_test") {
      const prResponse = await context.octokit.pulls.get({
        owner,
        repo: repoName,
        pull_number: pullNumber,
      });
      const pr = prResponse.data;
      const outputText = checkRun.output?.summary || "";

      const result = await commitReproTestFromSummary({
        octokit: context.octokit,
        owner,
        repoName,
        pullNumber,
        sender,
        summaryText: outputText,
        headSha: pr.head.sha,
        targetBranch: pr.head.ref,
      });

      await context.octokit.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pullNumber,
        body: result.message,
      });
      return;
    }

    if (identifier === "rerun_sandbox") {
      const prResponse = await context.octokit.pulls.get({
        owner,
        repo: repoName,
        pull_number: pullNumber,
      });
      const pr = prResponse.data;

      let probes: SandboxProbeRequest[] | undefined;
      let verificationGoal =
        "Re-run autonomous sandbox verification with a fresh container";
      let testCommand: string | undefined;
      let branch = pr.head.ref || "main";

      try {
        const job = getSandboxJobByCheckRun({
          owner,
          repo: repoName,
          checkRunId: checkRun.id,
        });
        if (job) {
          if (job.probesJson) {
            try {
              probes = JSON.parse(job.probesJson) as SandboxProbeRequest[];
            } catch {
              // ignore bad json
            }
          }
          if (job.verificationGoal) verificationGoal = job.verificationGoal;
          if (job.testCommand) testCommand = job.testCommand;
          if (job.branch) branch = job.branch;
        }
      } catch (jobErr) {
        app.log.warn({ jobErr }, "Could not load prior sandbox job for rerun");
      }

      // Best-effort recovery of objective/test command from prior check summary
      // (probe matrix rows are not reconstructed here; probes come from sandbox_jobs).
      if ((!probes || probes.length === 0) && checkRun.output?.summary) {
        const summary = checkRun.output.summary as string;
        const goalMatch = summary.match(/\*\*Objective:\*\*\s*(.+)/);
        if (goalMatch) verificationGoal = goalMatch[1].trim();
        const cmdMatch = summary.match(/\*\*Baseline Command:\*\*\s*`([^`]+)`/);
        if (cmdMatch) testCommand = cmdMatch[1];
      }

      await context.octokit.issues.createComment({
        owner,
        repo: repoName,
        issue_number: pullNumber,
        body: `🔄 **hq-jr** re-dispatching Tier 3 sandbox verification for PR #${pullNumber} (requested by @${sender}).`,
      });

      const authToken = await resolveInstallationToken(context.octokit);
      executeSandboxCheckRun({
        octokit: context.octokit,
        owner,
        repo: repoName,
        pullNumber,
        headSha: pr.head.sha,
        branch,
        verificationGoal,
        testCommand,
        probes,
        authToken,
      }).catch((sandboxErr: unknown) => {
        app.log.warn({ sandboxErr, pullNumber }, "Rerun sandbox verification failed");
      });
    }
  });
};
