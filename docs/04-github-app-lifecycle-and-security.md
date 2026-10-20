# GitHub App Lifecycle, Permissions, and Security

## Registration and Manifest Flow

`hq-jr` runs as a GitHub App rather than an OAuth App or personal access token. GitHub Apps provide installation-level isolation, granular permissions, and short-lived tokens.

### Method 1: Probot App Manifest (Recommended)

Probot provides an automated manifest flow:
1. Run `npm start` locally.
2. Visit `http://localhost:3000`.
3. Click **Register a GitHub App**.
4. The wizard registers `hq-jr`, generates the private key, configures webhook endpoints, and writes the credentials into your local `.env`.

### Method 2: Manual Registration via GitHub CLI or Web

To register manually at `https://github.com/settings/apps/new`:
- **App Name.** `hq-jr` (or `hq-jr-[your-org]`).
- **Homepage URL.** Repository URL or documentation site.
- **Webhook URL.** Deployed server URL (or Smee channel URL for local development).
- **Webhook Secret.** A cryptographically secure random string (`openssl rand -hex 20`).

## Required Permissions (Principle of Least Privilege)

The bot requires only the following permissions:

| Permission | Access | Justification |
| :--- | :--- | :--- |
| **Pull requests** | `Read & write` | Read PR metadata, diffs, and post line-anchored review comments. |
| **Repository contents** | `Read & write` | Read changed files and blobs, and commit automated remediation branches (`hq-jr/fix-pr-<id>`). |
| **Checks** | `Read & write` | Create and update Check Runs to show review progress and verdicts. |
| **Issues** | `Read & write` | Comment on PR conversation threads and process `@hq-jr review` or `@hq-jr fix` commands. |
| **Metadata** | `Read` | Required by GitHub for all GitHub Apps to resolve repository IDs. |

### Webhook Events Subscribed

The app manifest (`app.yml`) registers listeners for four event classes:

- `pull_request` (`opened`, `synchronize`, `reopened`).
- `pull_request_review_comment` (`created`).
- `issue_comment` (`created`).
- `check_run` (`rerequested` and `requested_action`). The action buttons are `Commit Repro Test` and `Re-run Sandbox`.

## Authentication Mechanics

GitHub App authentication uses a two-tier token exchange:

```
+-------------------------------------------------------------+
|                     hq-jr Server                            |
|                                                             |
|  1. Generate RS256 JWT                                      |
|     - Header: { alg: "RS256", typ: "JWT" }                  |
|     - Payload: { iss: APP_ID, exp: now+10m, iat: now-1m }   |
|     - Sign with: PRIVATE_KEY (*.pem)                        |
|                                                             |
|  2. POST /app/installations/{installation_id}/access_tokens |
|     - Authorization: Bearer <JWT>                           |
|                                                             |
|  3. Receive Installation Access Token                       |
|     - Scope: Restricted to installed repository             |
|     - Lifetime: Exactly 60 minutes                          |
+------------------------------+------------------------------+
                               |
                               | Authenticated REST / GraphQL
                               v
+-------------------------------------------------------------+
|                        GitHub API                           |
+-------------------------------------------------------------+
```

Probot handles token generation and refresh automatically.

## Security Boundaries and Data Protection

### 1. Untrusted Code Stays Off the Bot Host
`hq-jr` parses diffs and reasons over them as text. The Probot process never executes target build scripts, test runners, or binaries. When Tier 3 verification is enabled, the Antigravity agent clones the repository and runs the requested test command inside a remote sandbox (`environment: "remote"`). Treat that sandbox as untrusted: do not attach privileged host mounts or long-lived credentials.

### 2. Secret Redaction at the Model Boundary
The context packager scrubs packaged diff and file text before it is sent to Vertex AI:
- Matches private keys, GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Google `AIza` API keys, AWS access key IDs and secret-key assignments, Slack `xox[baprs]` tokens, JWTs, OpenAI/Anthropic `sk-` tokens, and generic `password` / `secret` / `api_key` / `access_token` assignments with fixed regular expressions. It does not use entropy scoring.
- Replaces matches with `[REDACTED_SECRET]` placeholders.
- Scrubs the PR title and body before interpolation, then labels them as untrusted metadata in the prompt. Tier 3 clones the repository directly and does not use this scrubber.
- Escapes the untrusted wrapper tags (`<untrusted_pr_metadata>`, `<untrusted_context>`, `<untrusted_diff>`) in the PR title, body, file list, and diff payload. Without this, a PR body containing a closing tag would end the untrusted region early and place the remaining content outside it. The escape is applied to the PR title, body, author, file list and diff payload that reach the review and triage prompts. The remediation prompt interpolates the file path and the file body into its own wrapper and is not covered by this escape.

### 3. Role-Based Access Control (RBAC) on Privileged Commands
For automated remediation and privileged actions (`@hq-jr fix`, `patch`, `remediate`, optional `and merge`, `commit-repro`, merge-only commands, and check-run action buttons):
- The bot verifies caller identity using `octokit.repos.getCollaboratorPermissionLevel`.
- Only collaborators with `admin` or `write` permissions are permitted to trigger automated commits, merges, or sandbox actions.
- Non-collaborators or unauthorized users receive an immediate `⛔ Access Denied` response in the PR timeline.
- `@hq-jr review` / `audit` / `scan` / `diff` is not RBAC-gated; any commenter on the pull request can request a review.

### 4. Review Comment Anti-Hijacking
- In `pull_request_review_comment.created` events, if a user replies to an existing review thread without mentioning `@hq-jr`, the bot traverses the thread history.
- The bot only replies without a mention when hq-jr authored the thread root. Being a later participant is not enough, so human-to-human peer reviews stay quiet.

### 5. Memory Management and Denial-of-Service Defense
- In-flight reviews are gated via SQLite `active_runs` (`acquireRunLock` / `releaseRunLock`) inside `try ... finally` so concurrent webhooks for the same pull request do not double-run. The lock key is `owner/repo#pullNumber`, not the head SHA, so a webhook that arrives while the lock is held is dropped with a warning instead of queued.
- Historical remediation commit hashes are stored in SQLite `remediation_commits` (pruned retention) so they survive process restarts and stay bounded.
