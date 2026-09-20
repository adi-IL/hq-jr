# Contributing to hq-jr

Thanks for helping. Keep changes small and easy to review.

## Requirements

- Node.js **22+**
- npm (lockfile is committed; use `npm ci`)
- Google Cloud ADC only if you exercise live Vertex paths (most unit tests mock AI)

## Setup

```bash
git clone https://github.com/adi-IL/hq-jr.git
cd hq-jr
npm ci
cp .env.example .env
# fill APP_ID, PRIVATE_KEY, WEBHOOK_SECRET, GOOGLE_CLOUD_PROJECT as needed
npm run build
npm test
```

## Before you open a PR

1. `npm run typecheck`
2. `npm test`
3. No secrets in the diff (no `.env`, keys, tokens, or personal ADC files)
4. Prefer one concern per PR
5. Update docs when behavior or env vars change

## Code style

- TypeScript, ESM (`"type": "module"`)
- Match existing naming and file layout under `src/`
- Zod schemas live in `src/schemas/`
- Services stay under `src/services/`
- Tests sit next to code as `*.test.ts` (Vitest)
- Avoid drive-by refactors unrelated to the fix

## Pull request etiquette

- Describe *why*, not only *what*
- Link related issues when they exist
- Do not paste production webhook secrets or private keys into PR text
- Mentions of `@hq-jr` in this repo only matter if the App is installed

## License

Contributions are under Apache-2.0 (see [LICENSE](LICENSE)).
