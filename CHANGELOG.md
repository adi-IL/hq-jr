# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Tier 3 `pollSandboxInteraction` polls Antigravity interactions and sets Check Run conclusions from real verdicts (with backoff; tests inject short polls).
- SQLite `review_findings` table plus merge path in `review-memory` (prefer prior SHAs; scrub bodies; hq-jr-only GitHub filter).
- SQLite `sandbox_jobs` for interaction/check linkage and rerun context.
- `@hq-jr commit-repro` comment command sharing logic with the Commit Repro Test check action.
- `rerun_sandbox` requested_action handler (write/admin RBAC).

### Changed

- Sandbox Check Run stays `in_progress` after dispatch (no success-on-dispatch).
- Remediation triggers only on explicit `@hq-jr fix|patch|remediate` (optional `and merge`).
- Docs aligned: SQLite concurrency (not BoundedShaCache), `generateContent` + `responseSchema`, Flash remediation (not Antigravity), honest Tier 3 poll wording, `withRetry` count, Cloud Run SQLite persistence note.

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

[Unreleased]: https://github.com/adi-IL/hq-jr/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.2
[0.1.1]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.1
[0.1.0]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.0
