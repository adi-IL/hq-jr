# Security Policy

## Supported versions

| Version | Supported |
| :--- | :--- |
| 0.1.x | Yes |

## Threat model (short)

`hq-jr` is a self-hosted GitHub App. Review traffic stays on your infrastructure and Google Cloud Vertex AI. It is not a SaaS black box.

### What we protect

1. **Webhook authenticity.** Probot verifies `X-Hub-Signature-256` (HMAC-SHA256) with `WEBHOOK_SECRET`. Unsigned or bad-signature deliveries are rejected.
2. **Secret scrubbing.** Before diff and file content is sent to Vertex AI, [`src/services/scrubber.ts`](src/services/scrubber.ts) redacts common credentials (GitHub PATs, OpenAI/Anthropic keys, PEM private keys, JWTs). Matches become `[REDACTED_SECRET]`. PR title and body are scrubbed and labeled as untrusted prompt metadata. Tier 3 clones the repository directly and does not pass through this scrubber.
3. **Sandbox isolation.** Tier 3 reproduction (experimental Antigravity agent) runs remotely and may execute the requested test command there. It does not execute target code in the bot host process. Treat the sandbox as untrusted; do not point sandbox runners at privileged host mounts.
4. **Mention gating.** The bot ignores peer-to-peer PR chatter unless `@hq-jr` is mentioned or a user replies in a review thread hq-jr started. That limits notification spam and social engineering via comment floods.
5. **Remediation RBAC.** Explicit `@hq-jr fix` / `patch` / `remediate`, merge commands, `commit-repro`, and check action buttons require collaborator `admin` or `write` on the repo. `@hq-jr review` does not add a separate permission check.

### What never leaves your control (by design)

- GitHub App `PRIVATE_KEY`, `WEBHOOK_SECRET`, and installation tokens stay on the host (or your secret manager).
- Raw unscrubbed diffs are not written to third-party SaaS review APIs. Model calls go to **Vertex AI in your GCP project**.
- SQLite review memory (`HQ_JR_DB_PATH`) is local to the deployment.

### Residual risks

- A compromised host or leaked App private key can post as the App. Rotate keys immediately.
- Scrubbers are regex-based. Novel secret formats may slip through. Prefer short-lived credentials and pre-commit secret scanning.
- Tier 3 clones the repository and can read files outside the packaged diff. Treat that sandbox and its network access as part of your trust boundary.
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

## Recommended repository settings

- **Enable secret scanning.** GitHub secret scanning finds credentials that land in the repository and alerts on them.
- **Enable secret scanning push protection.** Push protection blocks a push that contains a known secret shape, so a credential never reaches the history in the first place.
- **Never commit the Application Default Credentials file.** A `gcloud/` directory in a checkout is gitignored and excluded from the Docker build context, and CI fails if a credential JSON appears under it. On the deploy host the file lives in `/opt/hq-jr/gcloud/`, outside any checkout, so git never tracks it.
- **Mount the ADC directory read-only.** The container gets `/gcloud` as a read-only mount that holds only `application_default_credentials.json`, owned by uid `1001`. Never mount the whole home directory or the wide `~/.config/gcloud` directory into the container.
