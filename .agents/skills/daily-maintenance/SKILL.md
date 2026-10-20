---
name: daily-maintenance
description: Run the hq-jr checks a maintainer runs before a pull request. Use for daily maintenance, a pre-PR pass, or "is the tree green".
---

# Daily maintenance

Run these from the repo root, in this order.

1. `npm run typecheck`
2. `npm test`
3. `node scripts/check-doc-drift.mjs`
4. `node scripts/check-doc-code-sanity.mjs`
5. `node scripts/check-package-contents.mjs`
6. `node scripts/check-agents-files.mjs`

Stop at the first failure. Fix that failure before the next command.

`package.json` owns the npm scripts. `CONTRIBUTING.md` is the same list for a human.
