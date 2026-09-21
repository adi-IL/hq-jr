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
| **Repository contents** | `Read & write` | Ingest source code trees, parse symbols, and commit automated remediation branches (`hq-jr/fix-pr-<id>`). |
| **Checks** | `Read & write` | Create and update Check Runs to show review progress and verdicts. |
| **Issues** | `Read & write` | Comment on PR conversation threads and process `@hq-jr review` or `@hq-jr fix` commands. |
| **Metadata** | `Read` | Required by GitHub for all GitHub Apps to resolve repository IDs. |

### Webhook Events Subscribed

The app manifest (`app.yml`) registers listeners for four event classes:

- `pull_request` (`opened`, `synchronize`, `reopened`).
- `pull_request_review_comment` (`created`).
- `issue_comment` (`created`).
- `check_run` (`rerequested`).

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

### 1. Zero Untrusted Code Execution
`hq-jr` strictly parses source code using unified diff parsing and AI semantic reasoning. The bot never executes arbitrary build scripts, test runners, or binaries from target pull requests.

### 2. Secret Redaction at Boundary
Before transmitting source code or diffs to Vertex AI, the context packager passes all text through a credential scrubber:
- Matches high-entropy strings, private keys (`-----BEGIN PRIVATE KEY-----`), JWTs, Anthropic (`sk-ant-`), OpenAI (`sk-proj-`, `sk-admin-`), fine-grained GitHub PATs (`github_pat_`), and legacy tokens (`ghp_`, `gho_`).
- Replaces matches with `[REDACTED_SECRET]` placeholders.
- Protects private credentials from appearing in model logs.

### 3. Role-Based Access Control (RBAC) on Remediation
For automated code remediation commands (`@hq-jr fix`, `@hq-jr patch`, `@hq-jr fix and merge`):
- The bot verifies caller identity using `octokit.repos.getCollaboratorPermissionLevel`.
- Only collaborators with `admin` or `write` permissions are permitted to trigger automated commits or merges.
- Non-collaborators or unauthorized users receive an immediate `⛔ Access Denied` response in the PR timeline.

### 4. Review Comment Anti-Hijacking
- In `pull_request_review_comment.created` events, if a user replies to an existing review thread without mentioning `@hq-jr`, the bot traverses the comment thread history.
- The bot only replies if `hq-jr` was already a participant in that specific thread. Human-to-human peer reviews are completely ignored.

### 5. Memory Management and Denial-of-Service Defense
- In-flight reviews are gated via SQLite `active_runs` (`acquireRunLock` / `releaseRunLock`) inside `try ... finally` so concurrent webhooks for the same PR/SHA do not double-run.
- Historical remediation commit hashes are stored in SQLite `remediation_commits` (pruned retention) so they survive process restarts and stay bounded.
