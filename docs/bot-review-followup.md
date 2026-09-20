# Packaging review follow-up

Response to `hq-jr` findings on PR #1 and PR #2 (merged).

## Addressed on `master` (`3a2d65f`)

- Dockerfile: `tini` as PID 1 and Probot started directly (no `npm start` as PID 1).
- `.dockerignore`: ignore `.env*` with `!.env.example`.
- `package.json` author: GitHub profile URL form instead of invalid `<adi-IL>` email shape.
- Release workflow: bump version, then build with `NODE_ENV=production`, push git tag, then `npm publish`.
- Release workflow: `NODE_ENV=test` only on the test step.
- Release workflow: build image with `load: true`, push tags, then `docker save` for the release asset (no registry re-pull).

## Intentionally not changed

- Direct `git push` to `master` with `GITHUB_TOKEN`: this repo has been releasing successfully without branch-protection failures. Revisit if rulesets are enabled later.

Please re-audit the packaging paths on this branch.
