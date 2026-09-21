# System Architecture and Probot Framework

## Overview

`hq-jr` is an automated code review bot built as a GitHub App. It analyzes entire codebases and incremental pull requests for public and private repositories. The bot uses the Probot framework on Node.js and TypeScript.

The system uses Google Cloud Vertex AI via Application Default Credentials (ADC) for all model interactions. It distributes review tasks across three model tiers:
- Gemini 3.8 Flash with High Thinking for triage (narrow schema: overall risk `LOW`/`MEDIUM`/`HIGH`, `shouldReview`).
- Gemini 3.8 Flash with High Thinking for deep semantic review (finding severity `CRITICAL`/`WARNING`/`SUGGESTION`), memory-backed audits, and inline comments.
- antigravity-preview-05-2026 for asynchronous sandbox verification, build and test execution, and remediation synthesis.

## Probot Core Mechanics

Probot abstracts webhook verification, GitHub App authentication, and Octokit client management.

```
+------------------------------------------------------------------------+
|                               GitHub                                   |
|   (Pull Requests, Push, Check Runs, Issues, Repository Dispatch)       |
+-----------------------------------+------------------------------------+
                                    | Webhook (HTTPS POST)
                                    v
+------------------------------------------------------------------------+
|                            hq-jr Server                                |
|                                                                        |
|  +------------------------------------------------------------------+  |
|  | Webhook Ingress (Probot / Express Middleware)                    |  |
|  | - HMAC SHA256 Signature Verification (WEBHOOK_SECRET)            |  |
|  | - Event Routing (`app.on('pull_request.opened', ...)` )          |  |
|  +---------------------------------+--------------------------------+  |
|                                    |                                   |
|                                    v                                   |
|  +------------------------------------------------------------------+  |
|  | Authentication Boundary                                          |  |
|  | - App ID + Private Key (RS256 JWT)                               |  |
|  | - Installation Token Exchange (scoped to repository)             |  |
|  | - Authenticated Octokit REST & GraphQL Client                    |  |
|  +---------------------------------+--------------------------------+  |
|                                    |                                   |
|                                    v                                   |
|  +------------------------------------------------------------------+  |
|  | Review Pipeline Controller                                       |  |
|  | - Scope Classifier (Full Codebase vs Incremental PR)             |  |
|  | - Review Memory & Prior Audit Context (`review-memory.ts`)        |  |
|  | - Remediation Engine & Git Tree Commits (`remediation.ts`)        |  |
|  | - Context Window Packager (`context-packager.ts`)                |  |
|  +---------------------------------+--------------------------------+  |
|                                    |                                   |
|                                    v                                   |
|  +------------------------------------------------------------------+  |
|  | AI Execution Engine (Vertex AI via ADC)                          |  |
|  | - Tier 1: Flash + High Thinking (triage schema)                  |  |
|  | - Tier 2: Flash + High Thinking (deep review schema)             |  |
|  | - Tier 3: antigravity-preview-05-2026 (Sandbox Verification)     |  |
|  +---------------------------------+--------------------------------+  |
|                                    |                                   |
|                                    v                                   |
|  +------------------------------------------------------------------+  |
|  | Egress & Reporting                                               |  |
|  | - GitHub Check Run Status (neutral, success, failure)            |  |
|  | - Inline Review Comments on PR Diff Lines                        |  |
|  | - Automated Branch Commits (`hq-jr/fix-pr-<id>`)                 |  |
|  +------------------------------------------------------------------+  |
+------------------------------------------------------------------------+
```

### Webhook Event Loop

The bot registers handlers for four GitHub event classes:

1. `pull_request.opened`, `pull_request.synchronize`, and `pull_request.reopened`. Triggers incremental diff reviews, retrieves prior audit findings via `review-memory.ts` to verify resolutions, and runs deep semantic analysis. Zero-hunk PRs (pure permissions or binary diffs) complete neutrally without LLM cost.
2. `pull_request_review_comment.created`. Answers developer inquiries on inline diff comments with multi-turn thread continuity. Human-to-human peer reviews are safely ignored via thread participation checks.
3. `issue_comment.created`. Listens for commands on pull requests, guarded by RBAC checks (`admin`/`write` permissions required):
   - `@hq-jr review` or `@hq-jr audit`: Runs on-demand deep reviews.
   - `@hq-jr fix` or `@hq-jr patch`: Synthesizes code fixes, creates a remediation branch, and commits patches.
   - `@hq-jr fix and merge`: Synthesizes code fixes and auto-merges into the target branch when permitted.
4. `check_run.rerequested`. Re-runs the review pipeline when requested from the GitHub UI checks tab.

### Octokit REST and GraphQL Integration

Probot attaches a pre-authenticated `context.octokit` to each event:
- REST API: handles check run creation (`octokit.checks.create`), status updates (`octokit.checks.update`), inline comments (`octokit.pulls.createReview`), branch creation (`octokit.git.createRef`), and blob updates.
- GraphQL API: handles auto-merging (`octokit.graphql(enablePullRequestAutoMerge)`) and repository metadata queries.

## GitHub CLI (gh) Integration

The bot pairs with the host's existing `gh` CLI for administrative workflows, local simulation, and headless execution:

1. **Manifest Registration.** Automated app creation using `gh api` and Probot app manifests.
2. **Local Token Verification.** Testing repository permissions via `gh auth status` and `gh api /installation/repositories`.
3. **Webhook Simulation.** Triggering synthetic test events via `gh api -X POST /repos/{owner}/{repo}/dispatches`.
4. **Direct PR Review Triggering.** Running `hq-jr review --pr <number>` locally using the user's active GitHub credentials without waiting for webhooks.

## Concurrency, Idempotency, and Deadlock Prevention

GitHub webhooks deliver at least once and can arrive out of order:
- Each review run uses a SQLite `active_runs` mutex keyed by `owner/repo#pullNumber` (`acquireRunLock` / `releaseRunLock` in `db.ts`), with TTL recovery for stale locks.
- In-flight runs are guarded inside a strict `try ... finally` so the lock is always released, even on GitHub API 403, 429, or network timeouts.
- Known remediation commits synthesized by `hq-jr` are recorded in the SQLite `remediation_commits` table (pruned to a recent window) to prevent self-trigger feedback loops across process restarts.
- Prior review findings persist in SQLite `review_findings` for continuity across pushes; GitHub bot reviews remain a supplement.
- If a newer commit arrives on the same PR branch, subsequent webhooks review the newest SHA.
