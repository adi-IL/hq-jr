---
name: release-guard
description: Stop an unasked hq-jr release. Use before a version bump, a v* tag, an npm publish, or a deploy claim.
---

# Release guard

Do not run `scripts/bump-version.mjs`. Do not push a `v*` tag. Do not run `npm publish`. Do any of those only when the operator asked for a release in the current turn.

A `v*` tag starts `.github/workflows/release.yml`. That workflow publishes npm, the GHCR image, and a GitHub Release. The release is not done when npm succeeds and the image job fails. Call it done only after the image job is green and the GitHub Release exists.

A changelog commit on `master` after the tag is the existing convention. That commit does not need another tag.

`deploy/README.md` is how a person updates the host. Do not SSH or copy files onto the host from this skill.
