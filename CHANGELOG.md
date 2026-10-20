# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.11] - 2026-10-21

### Added

- `AGENTS.md`, `.agents/skills/` (`daily-maintenance`, `release-guard`, `review-loop`), and `scripts/check-agents-files.mjs` in CI to enforce line limits, valid repository paths, and secret checks on agent instruction files.

### Fixed

- Tier 3 sandbox dispatch (`ai.interactions.create` and `ai.interactions.get`) failed with `TypeError: Failed to parse URL from [object Request]` because `@google/genai` passes a native `Request` instance to `aiFetch`, and the bundled `undici` package rejected native `Request` objects. `aiFetch` now extracts the native `Request` URL and metadata via `toAiFetchInit` before dispatching through `aiDispatcher`.

## [0.1.10] - 2026-10-20

### Fixed

- The release workflow could not build the container image. The step that reads the release tag from origin sent its own `Authorization` header while the checkout above it had persisted one of the same name, so GitHub answered 400 "Duplicate header" and the image was never built. The image and release jobs now check out without persisting a credential, and a test fails if a step sends its own header in a job whose checkout persists one.
- The two sandbox allowlist tests read the first recorded call of a shared spy instead of the call of the dispatch under test, so they asserted one language's allowlist against another's. Vitest 5 hands back the same spy when a method is spied again, where Vitest 2 handed back a fresh one.

## [0.1.9] - 2026-10-20

### Added

- Gemini 4 Argon escalation tier. A high-risk triage result routes the deep review to `gemini-4-argon` (`HQ_JR_MODEL_ESCALATION`) instead of `gemini-3.8-flash`. The gate is `HQ_JR_ESCALATION_MIN_RISK`, default `HIGH`. Argon costs roughly 2.7x Flash per token, so it stays off low-risk changes.
- Per-workload model routing. Triage, deep review, escalation, discussion replies, remediation synthesis, and the health probe each read their own variable (`HQ_JR_MODEL_TIER1`, `HQ_JR_MODEL_TIER2`, `HQ_JR_MODEL_ESCALATION`, `HQ_JR_MODEL_DISCUSSION`, `HQ_JR_MODEL_REMEDIATION`, `HQ_JR_MODEL_HEALTH`). Raising one no longer raises the others.
- `HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS` caps output on the escalation model. Tier 1 and Tier 2 keep their previous uncapped behavior.
- Tag-driven releases. A `v*` tag push publishes to npm with provenance, builds and pushes the image, and creates the GitHub Release. The version comes from the tag, so a release is a re-runnable operation instead of a branch write-back race.
- `scripts/bump-version.mjs` performs the version bump, commit, and annotated tag locally, so the release sequence is explicit and reviewable.
- The deploy files ship inside the image at `/app/deploy`, so a host can extract the updater that matches its release.

### Fixed

- Prompt-injection escape gap. A PR title or body containing `</untrusted_context>` closed the outer wrapper, so the rest of the PR content landed outside the untrusted region. The metadata, file list, triage diff, and review payload are now escaped together.
- Diff parsing dropped deleted lines whose content began with `-- `, which shifted every later line anchor in that hunk. The parser now treats `--- ` and `+++ ` as headers only outside a hunk body.
- A file whose diff contained the digits `160000` was misread as a git submodule, which blocked every inline comment on that file. Submodule detection now reads the git index line.
- The file filter classified whole-path substrings, so `src/AuthorProfile.tsx` scored as security-sensitive and `src/server/reviewer.ts` scored as frontend. Security terms now match whole path tokens and compound names.
- The credential scrubber rewrote environment references such as `process.env.SECRET_KEY` into placeholders, so the model reviewed mangled source. Unquoted values containing a dot are redacted again.
- The context packager measured its character budget before scrubbing, so the emitted prompt could exceed the cap. The cap now applies to the text actually sent.
- Renamed files are listed in the check summary when a pull request has no textual hunks, instead of reporting no code changes.

### Changed

- Vitest 5.0.5 replaces Vitest 2.1.9, which drops the `tinypool` worker pool and its two prototype-pollution advisories. The declared Node floor moves to 22.12.0, which Vitest 5 requires, and `source-map-js` moves to 1.2.2.
- `@sentry/node` is pinned to 10.76.2. Probot 13 pulled a version that carried the vulnerable `@opentelemetry/core` and the database instrumentation packages into the production image.
- Release no longer attaches a container tarball to the GitHub Release. The image is pulled with `docker pull`.
- The CI job is named "Typecheck, Test, and Build" because `npm run lint` only runs the TypeScript compiler.
- GitHub secret scanning and push protection are enabled on the repository, and the `gcloud/` directory holding Application Default Credentials is ignored by git and excluded from the Docker build context.

## [0.1.8] - 2026-10-19

### Added

- `/livez` process liveness endpoint. Container health checks and `deploy/update.sh` use it; `/healthz` remains the Vertex AI readiness probe.
- Deploy updater rollback: it respects compose image pins, restores the previous image after a failed health check, skips a known-bad digest until a new one appears, bounds probes with a timeout, and removes the replaced image when possible.

### Fixed

- Scrub PR title and body before they enter the review prompt, label them as untrusted metadata, and escape delimiter variants that could close the wrapper.
- Stage ADC in a dedicated directory readable by container uid 1001 and mount only that directory.
- Handle `docker compose up` failures without marking the digest bad; transient failures are retried on the next run.
- Retry release tag pushes and push a recovery branch plus a commit-patch artifact if all attempts fail.
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

[Unreleased]: https://github.com/adi-IL/hq-jr/compare/v0.1.10...HEAD
[0.1.10]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.10
[0.1.9]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.9
[0.1.8]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.8
[0.1.7]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.7
[0.1.6]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.6
[0.1.5]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.5
[0.1.3]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.3
[0.1.2]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.2
[0.1.1]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.1
[0.1.0]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.0
