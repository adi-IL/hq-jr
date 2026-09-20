/**
 * Patterns matching high-risk secrets and credentials.
 */
const SECRET_PATTERNS = [
  // Private keys (RSA, EC, PGP, OPENSSH)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,

  // GitHub tokens (Classic tokens, OAuth, App tokens, and Fine-Grained PATs)
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,

  // Google Cloud API keys and service account private keys
  /\bAIza[0-9A-Za-z-_]{35}\b/g,

  // AWS Access Key ID
  /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g,

  // AWS Secret Access Key (heuristics near keywords)
  /(?:aws_secret_access_key|aws_access_key_id|secret_key)\s*[:=]\s*["'`]?([A-Za-z0-9/+=]{40})["'`]?/gi,

  // Slack tokens
  /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*\b/g,

  // Generic JWT tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,

  // OpenAI / Anthropic / Generic AI API tokens (including modern sk-proj-, sk-ant-api03-, sk-admin-)
  /\bsk-(?:proj-|admin-|ant-(?:api03|admin01)-)?[a-zA-Z0-9_-]{20,250}\b/g,

  // Generic secret / password assignments in code, JSON, YAML, and .env
  /(?:["']?(?:password|passwd|api_key|apiKey|secret|private_token|client_secret|access_token|auth_token|refresh_token|api_secret)["']?)\s*[:=]\s*["'`]?([^"'`\r\n\s]{8,128})["'`]?/gi,
];

/**
 * Scrubs credentials and secrets from text before transmission to AI models.
 */
export function scrubSecrets(input: string): { scrubbed: string; redactedCount: number } {
  if (!input) {
    return { scrubbed: "", redactedCount: 0 };
  }

  let scrubbed = input;
  let redactedCount = 0;

  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, (match, ...args) => {
      redactedCount++;
      const captures = args.slice(0, -2);
      if (captures.length > 0 && typeof captures[0] === "string" && captures[0].length > 0) {
        return match.replace(captures[0], "[REDACTED_SECRET]");
      }
      return "[REDACTED_SECRET]";
    });
  }

  return { scrubbed, redactedCount };
}
