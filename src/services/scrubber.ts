/**
 * Patterns matching high-risk secrets and credentials.
 *
 * Known limitation: a regex only scrubber cannot tell a real credential from
 * an arbitrary string of the same shape. Tokens with an unexpected length
 * (ghp_ under 36 characters, github_pat_ that is not exactly 82, AIza that is
 * not exactly 35, generic values under 8 characters) are not redacted.
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
];

const REDACTION_PLACEHOLDER = "[REDACTED_SECRET]";

/**
 * Generic secret / password assignments in code, JSON, YAML, and .env.
 * The value may be quoted, unquoted, a member expression, or a bracket access.
 */
const GENERIC_ASSIGNMENT_REGEX =
  /(?:["']?(?:password|passwd|api_key|apiKey|secret|private_token|client_secret|access_token|auth_token|refresh_token|api_secret)["']?)\s*[:=]\s*(["'`]?)((?:[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\[(?:["'][^"'\r\n]*["']|[A-Za-z_$][A-Za-z0-9_$]*)\])|(?:[^"'`\r\n\s]{8,128}))["'`]?/gi;

const ENV_REFERENCE_REGEX =
  /^(?:process|globalThis|global|Deno|Bun)\.env\b|^os\.environ\b|^(?:import\.meta\.)?env\b|^this\.env\b/;

const MEMBER_EXPRESSION_REGEX =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^\]]*\])+$/;

const TRAILING_PUNCTUATION_REGEX = /[;,)\]}]+$/;

/**
 * Roots that name a configuration lookup. A value that starts with one of
 * them points at configuration instead of holding a credential.
 */
const CODE_REFERENCE_ROOTS = [
  "process.env",
  "os.environ",
  "import.meta.env",
  "globalThis.env",
  "this.env",
  "Deno.env",
  "Bun.env",
  "env",
  "config",
  "settings",
];

/**
 * A bracket access reads a property, so it is code and not a literal.
 */
const BRACKET_PROPERTY_READ_REGEX =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\[(?:["'][^"'\r\n]*["']|[A-Za-z_$][A-Za-z0-9_$]*)\]$/;

const BRACKET_ACCESS_SUFFIX_REGEX = /\[[^\]\r\n]*\]$/;

/**
 * Splits a captured value into the value itself and the punctuation that
 * closes the statement it appears in. A bracketed value keeps its brackets.
 */
function splitTrailingPunctuation(value: string): { core: string; trailing: string } {
  if (value.startsWith("[") && value.endsWith("]")) {
    return { core: value, trailing: "" };
  }
  if (BRACKET_ACCESS_SUFFIX_REGEX.test(value)) {
    return { core: value, trailing: "" };
  }
  const trailing = TRAILING_PUNCTUATION_REGEX.exec(value)?.[0] ?? "";
  return { core: value.slice(0, value.length - trailing.length), trailing };
}

/**
 * A value that points at configuration instead of holding a credential, such
 * as process.env.SECRET_KEY, is code the reviewer needs to see untouched. A
 * bare word that merely contains a dot is not a reference.
 */
function isReferenceValue(value: string, quote: string): boolean {
  if (!value) {
    return true;
  }
  if (quote) {
    return false;
  }
  if (ENV_REFERENCE_REGEX.test(value)) {
    return true;
  }
  if (BRACKET_PROPERTY_READ_REGEX.test(value)) {
    return true;
  }
  if (!MEMBER_EXPRESSION_REGEX.test(value)) {
    return false;
  }
  return CODE_REFERENCE_ROOTS.some(
    (root) => value === root || value.startsWith(`${root}.`) || value.startsWith(`${root}[`)
  );
}

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
      const captures = args.slice(0, -2);
      const capture = captures.length > 0 && typeof captures[0] === "string" ? captures[0] : "";
      const replacement =
        capture.length > 0 ? match.replace(capture, REDACTION_PLACEHOLDER) : REDACTION_PLACEHOLDER;
      if (replacement !== match) {
        redactedCount++;
      }
      return replacement;
    });
  }

  scrubbed = scrubbed.replace(GENERIC_ASSIGNMENT_REGEX, (match, quote: string, value: string) => {
    const { core, trailing } = splitTrailingPunctuation(value);
    if (!core || isReferenceValue(core, quote)) {
      return match;
    }
    const valueIndex = match.lastIndexOf(value);
    const replacement =
      valueIndex >= 0
        ? match.slice(0, valueIndex) +
          REDACTION_PLACEHOLDER +
          trailing +
          match.slice(valueIndex + value.length)
        : match;
    if (replacement !== match) {
      redactedCount++;
    }
    return replacement;
  });

  return { scrubbed, redactedCount };
}
