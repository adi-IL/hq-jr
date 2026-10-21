# Launch draft

The maintainer posts these manually. Agents must not post to Hacker News, X, or Reddit.

## One-line summary

The self-hosted pull request reviewer that can reproduce suspicious breaks in an isolated sandbox.

## Show HN draft

Title: `Show HN: hq-jr, a self-hosted PR reviewer with sandbox bug reproduction`

Body:

`hq-jr` is a self-hosted GitHub App built on Probot. It reviews pull requests with Vertex AI inside your own Google Cloud project.

- **Sandbox verification.** Suspicious findings run in an isolated Antigravity container, and `hq-jr` waits for the reproduction verdict before completing the sandbox check run.
- **Mention gating.** Human review threads stay quiet until a comment mentions `@hq-jr`, except for replies in threads that `hq-jr` started.
- **Self-hosted privacy.** Review diffs are scrubbed for secrets before calling Vertex AI in your Google Cloud project. When Tier 3 runs, the Antigravity sandbox container clones the pull request branch to execute the reproduction check.

`hq-jr` also tracks prior findings in GitHub review threads with a SQLite WAL fallback, and it can generate a fix branch on `@hq-jr fix` for collaborators with `write` or `admin` access.

Repository: https://github.com/adi-IL/hq-jr
npm: https://www.npmjs.com/package/hq-jr

## Maintainer checklist

- [ ] Confirm Security Advisories are enabled on the public repository.
- [ ] Rotate any secrets that ever lived in old private notes.
- [ ] Post to Show HN when ready.
