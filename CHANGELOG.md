# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet beyond 0.1.0 packaging.

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

[Unreleased]: https://github.com/adi-IL/hq-jr/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/adi-IL/hq-jr/releases/tag/v0.1.0
