# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/livez` process liveness endpoint. Container health checks and `deploy/update.sh` use it; `/healthz` remains the Vertex AI readiness probe.
- Deploy updater rollback: it respects compose image pins, restores the previous image after a failed health check, skips a known-bad digest until a new one appears, bounds probes with a timeout, and removes the replaced image when possible.

### Fixed

- Scrub PR title and body before they enter the review prompt and label them as untrusted metadata.
- Stage ADC in a dedicated directory readable by container uid 1001 and mount only that directory.
- Retry release tag pushes and print manual recovery details if all attempts fail.
- Remove the ineffective `Persistent=true` from the update timer and grant the update unit Docker access.

### Changed

- Documentation now matches the PR metadata scrubber, review-memory fallback, diff-text budgets, and the protected deployment paths.

## [0.1.7] - 2026-10-19

### Fixed

- Release workflow: keep the tag on the published commit, fail on registry errors other than E404, and bound the rebase/push retry.

## [0.1.6] - 2026-10-19

### Fixed

- Ship `smee-client` as a production dependency. The pruned image previously logged `Run npm install --save-dev smee-client` and received no webhooks when `WEBHOOK_PROXY_URL` was set.

## [0.1.5] - 2026-10-19

### Added

- Durable Tier 3 poll recovery: sandbox job heartbeats, `resumeStaleSandboxJobs`, lease tokens, and stale-job claims on startup and interval.
- Review finding resolution when a later review drops a prior path + line + title, plus pruning of resolved rows after the retention window.

### Fixed

- Sandbox conclusions fail closed on agent failure; completed checks expose no actions; infra `interactions.get` failures report an incomplete poll.
- Fork-safe commit-repro.
- Scrub secrets before writing SQLite review memory.
- Prefer unresolved hq-jr GitHub review threads; merge SQLite findings as a fallback with normalized titles.
- Stop review loops on hq-jr's own threads and findings.
- Release workflow derives the next version from `patch(max(package.json, npm latest))` and retags/rebases instead of looping on E409.

### Changed

- Remediation triggers only on explicit `@hq-jr fix|patch|remediate` (optional `and merge`).
- GitHub Actions bumped to current majors.

## [0.1.4] - 2026-10-19

### Deprecated

- Published to npm, but the release workflow lost the tag push race, so no `v0.1.4` tag or GitHub Release exists. Deprecated on npm ([0.1.4 on npm](https://www.npmjs.com/package/hq-jr/v/0.1.4)); use 0.1.5 or newer.

### Fixed

- Verify action refs before reporting them as missing.

## [0.1.3] - 2026-09-21

### Added

- Tier 3 `pollSandboxInteraction` sets check conclusions from real verdicts instead of success-on-dispatch.
- SQLite `review_findings` and `sandbox_jobs`, plus the review-memory merge path.
- `@hq-jr commit-repro` and the `Re-run Sandbox` check action.

### Changed

- Sandbox check stays `in_progress` after dispatch.
- Docs aligned on `generateContent` + `responseSchema`, Flash remediation, Tier 3 poll behavior, `withRetry`, and Cloud Run SQLite persistence.

## [0.1.2] - 2026-09-20

### Fixed

- Release workflow publishes to npm before pushing the version commit/tag (avoids registry lag on publish failure).
- Restored GitHub Release step after Docker tarball; Dockerfile `PATH` includes `node_modules/.bin` with `probot` CMD under tini.

### Notes

- Published to npm as `hq-jr@0.1.2`, GHCR as `ghcr.io/adi-il/hq-jr:0.1.2` / `:latest`, and GitHub Release with linux-amd64 image tarball.

## [0.1.1] - 2026-09-20

### Fixed

- Dockerfile SIGTERM via tini + direct Probot CMD (not `npm` as PID 1).
- `.dockerignore` excludes `.env*` except `.env.example`.
- `package.json` author uses a GitHub URL.
- Release workflow: bump → build (production) → publish/push ordering fixes, scoped `NODE_ENV`, local Docker load for release tarball.

### Changed

- Docs honesty: Tier 1 and Tier 2 both use High Thinking; triage vs deep review differ by schema/prompt. Clarified overall risk (`LOW`/`MEDIUM`/`HIGH`) vs finding severity (`CRITICAL`/`WARNING`/`SUGGESTION`).
- CLI help and Quickstart: global `hq-jr` is CLI-only; App daemon still needs `npm start` / Docker.

### Added

- GitHub Actions release workflow: npm publish, GHCR Docker image, and GitHub Release assets on push to master (unless `[skip release]`).

## [0.1.0] - 2026-09-20

### Added

- Initial public packaging of `hq-jr` as a self-hosted Probot GitHub App on Vertex AI.
- Multi-tier review funnel: Tier 1 triage, Tier 2 deep review with high thinking, experimental Tier 3 Antigravity sandbox reproduction.
- SQLite WAL review memory across commits.
- Secret scrubber before model calls.
- Mention gating so the bot stays quiet until `@hq-jr` is addressed.
- Remediation commands (`@hq-jr fix`) with collaborator write/admin checks.
- Community docs: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.
- Production-oriented Dockerfile for Cloud Run / container deploys.

### Notes

- Default models match `src/config.ts`: `HQ_JR_MODEL_TIER1` and `HQ_JR_MODEL_TIER2` are `gemini-3.8-flash`. Override Tier 2 with `gemini-3.1-pro-preview` if you want Pro.
- Tier 3 / Antigravity is experimental.

[Unreleased]: https://github.com/adi-IL/hq-jr/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.7
[0.1.6]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.6
[0.1.5]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.5
[0.1.3]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.3
[0.1.2]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.2
[0.1.1]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.1
[0.1.0]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.0
