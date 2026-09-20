# Security Policy

## Supported versions

| Version | Supported |
| :--- | :--- |
| 0.1.x | Yes |

## Threat model (short)

`hq-jr` is a self-hosted GitHub App. Review traffic stays on your infrastructure and Google Cloud Vertex AI. It is not a SaaS black box.

### What we protect

1. **Webhook authenticity.** Probot verifies `X-Hub-Signature-256` (HMAC-SHA256) with `WEBHOOK_SECRET`. Unsigned or bad-signature deliveries are rejected.
2. **Secret scrubbing.** Before any diff or file content is sent to Vertex AI, [`src/services/scrubber.ts`](src/services/scrubber.ts) redacts common credentials (GitHub PATs, OpenAI/Anthropic keys, PEM private keys, JWTs). Matches become `[REDACTED_SECRET]`.
3. **Sandbox isolation.** Tier 3 reproduction (experimental Antigravity agent) is meant to run in an isolated container harness, not on the bot host process. Do not point sandbox runners at privileged host mounts.
4. **Mention gating.** The bot ignores peer-to-peer PR chatter unless `@hq-jr` is mentioned or already in the thread. That limits notification spam and social engineering via comment floods.
5. **Remediation RBAC.** `@hq-jr fix` / merge paths require collaborator `admin` or `write` on the repo.

### What never leaves your control (by design)

- GitHub App `PRIVATE_KEY`, `WEBHOOK_SECRET`, and installation tokens stay on the host (or your secret manager).
- Raw unscrubbed diffs are not written to third-party SaaS review APIs. Model calls go to **Vertex AI in your GCP project**.
- SQLite review memory (`HQ_JR_DB_PATH`) is local to the deployment.

### Residual risks

- A compromised host or leaked App private key can post as the App. Rotate keys immediately.
- Scrubbers are regex-based. Novel secret formats may slip through. Prefer short-lived credentials and pre-commit secret scanning.
- Vertex AI receives scrubbed code context. Treat GCP IAM and project isolation seriously.

## Reporting a vulnerability

**Do not open a public issue for security bugs.**

1. Prefer [GitHub Security Advisories](https://github.com/adi-IL/hq-jr/security/advisories/new) (private report) on this repository.
2. If Advisories are unavailable, email the maintainer via the address on the [GitHub profile](https://github.com/adi-IL) and include:
   - affected version / commit
   - impact summary
   - reproduction steps (minimal)
   - whether exploit code is included

We aim to acknowledge within 7 days and ship a fix or mitigation for confirmed issues as soon as practical.

## Safe contribution rules

- Never commit `.env`, `.npmrc`, `*.pem`, service-account JSON, or live tokens.
- Use `.env.example` as the template only.
- If you accidentally push a secret, rotate it and contact the maintainer before force-pushing history.
