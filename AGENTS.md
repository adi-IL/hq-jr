# hq-jr agent instructions

hq-jr is a self-hosted GitHub App that reviews pull requests. This file is an index. Env defaults live in `src/config.ts`. Do not paste them here.

## Commands

The daily procedure is `.agents/skills/daily-maintenance/SKILL.md`.

- `npm run typecheck`
- `npm test`
- `npm run build`
- `node scripts/check-doc-drift.mjs`
- `node scripts/check-doc-code-sanity.mjs`
- `node scripts/check-package-contents.mjs`
- `node scripts/check-agents-files.mjs`

`package.json` holds the npm scripts. Node is `>=22.12.0`. `CONTRIBUTING.md` is the human pre-PR checklist. It also asks for a secret-diff check.

## Boundaries

Release stops are in `.agents/skills/release-guard/SKILL.md`.

Review stops are in `.agents/skills/review-loop/SKILL.md`.

Do not run `scripts/bump-version.mjs`, push a `v*` tag, or run `npm publish` unless the operator asked in this turn. That tag runs `.github/workflows/release.yml`.

Do not SSH to a deploy host. `deploy/README.md` is the host procedure for a person.

Do not print `.env`, private keys, webhook secrets, or ADC files. `SECURITY.md` is the policy. `.env.example` is the empty template.

Do not edit `dist` (build output).

Do not merge while `.github/workflows/ci.yml` is red.

## Where a call picks a model

`src/services/ai.ts` selects the model for a call. `docs/02-model-orchestration-and-vertex-adc.md` describes that routing. `docs/05-deployment-and-operations.md` holds the env table. When a sentence in the env doc disagrees with `src/services/ai.ts`, trust the code and fix the sentence.

## Upkeep

`scripts/check-agents-files.mjs` fails when this file is missing, longer than 120 lines, links a path that is not in the tree, or contains a secret-shaped token. The failure names the pattern. It does not print the token.
