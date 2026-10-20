/**
 * Patterns matching high-risk secrets and credentials.
 *
 * Known limitation: a regex only scrubber cannot tell a real credential from
 * an arbitrary string of the same shape. Tokens with an unexpected length
 * (ghp_ under 36 characters, github_pat_ that is not exactly 82, AIza that is
 * not exactly 35, generic values under 8 characters) are not redacted. An
 * unquoted generic value is kept when it reads configuration (process.env.X,
 * config.X, getSecret(...)); any other unquoted value is redacted.
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

/** Values shorter than this are too short to be a credential worth hiding. */
const MIN_GENERIC_SECRET_LENGTH = 8;

/**
 * Generic secret / password assignments in code, JSON, YAML, and .env.
 * Groups 1 and 2 are the quote and body of a quoted value; the body runs to
 * the matching close quote, so it may contain spaces. Group 3 is an unquoted
 * value, which may contain bracket access with quoted keys such as
 * credentials['api_key'].
 *
 * An unterminated bracket is consumed in one step by the second branch of the
 * value, so a value full of '[' and no ']' is scanned once instead of once
 * per bracket.
 */
const GENERIC_ASSIGNMENT_REGEX =
  /(?:["']?(?:password|passwd|api_key|apiKey|secret|private_token|client_secret|access_token|auth_token|refresh_token|api_secret)["']?)\s*[:=]\s*(?:(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1?|((?:\[[^\]\r\n]*\]|\[[^"'`\s]*|[^"'`\s])+))/dgi;

const ENV_REFERENCE_REGEX =
  /^(?:process|globalThis|global|Deno|Bun)\.env\b|^os\.environ\b|^(?:import\.meta\.)?env\b|^this\.env\b/;

/** Shell and .env interpolation such as $DB_PASSWORD or ${DB_PASSWORD}. */
const ENV_INTERPOLATION_REGEX = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

const MEMBER_EXPRESSION_REGEX =
  /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^\]]*\])+$/;

/** A call such as getSecret( or vault.read( is code, never a literal. */
const CALL_EXPRESSION_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\(/;

/**
 * Roots of member expressions that read configuration. A root counts when it
 * is one of these words or ends with one (applicationConfig, dbSettings,
 * user_credentials). Any other dotted value, such as hunter2.abc, can be a
 * credential, so it is redacted.
 */
const REFERENCE_ROOTS = new Set([
  "app",
  "args",
  "cfg",
  "conf",
  "config",
  "configuration",
  "context",
  "creds",
  "credentials",
  "ctx",
  "env",
  "environment",
  "options",
  "opts",
  "params",
  "props",
  "req",
  "request",
  "secrets",
  "self",
  "settings",
  "this",
  "vault",
]);

const CLOSING_TO_OPENING: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function countChar(text: string, char: string): number {
  let count = 0;
  for (const c of text) {
    if (c === char) {
      count++;
    }
  }
  return count;
}

/**
 * Length of the punctuation that closes the statement around an unquoted
 * value, such as the ";" in "apiKey = abc12345;". A closing bracket only
 * counts when it has no opening partner inside the value, so the "]" of
 * [REDACTED_SECRET] or of config["key"] stays part of the value.
 */
function trailingPunctuationLength(value: string): number {
  let end = value.length;
  while (end > 0) {
    const char = value[end - 1];
    if (char === ";" || char === ",") {
      end--;
      continue;
    }
    const opening = CLOSING_TO_OPENING[char];
    const head = value.slice(0, end);
    if (opening && countChar(head, char) > countChar(head, opening)) {
      end--;
      continue;
    }
    break;
  }
  return value.length - end;
}

/**
 * An unquoted value that points at configuration instead of holding a
 * credential, such as process.env.SECRET_KEY or config.apiKey, is code the
 * reviewer needs to see untouched.
 */
function isReferenceValue(value: string): boolean {
  if (ENV_REFERENCE_REGEX.test(value) || ENV_INTERPOLATION_REGEX.test(value)) {
    return true;
  }
  if (CALL_EXPRESSION_REGEX.test(value)) {
    return true;
  }
  const member = MEMBER_EXPRESSION_REGEX.exec(value);
  return member !== null && isReferenceRoot(member[1]);
}

function isReferenceRoot(root: string): boolean {
  if (REFERENCE_ROOTS.has(root.toLowerCase())) {
    return true;
  }
  const words = root.split(/[_$]+|(?<=[a-z0-9])(?=[A-Z])/).filter((word) => word.length > 0);
  return words.length > 1 && REFERENCE_ROOTS.has(words[words.length - 1].toLowerCase());
}

/**
 * Replaces the value of each generic secret assignment with the placeholder.
 * A value that an earlier pattern already replaced is left as is, so each
 * secret is counted once.
 */
function redactGenericAssignments(input: string): { text: string; count: number } {
  let text = "";
  let lastIndex = 0;
  let count = 0;

  for (const match of input.matchAll(GENERIC_ASSIGNMENT_REGEX)) {
    const quoted = match[1] !== undefined;
    const group = quoted ? 2 : 3;
    const value = match[group] ?? "";
    const span = match.indices?.[group];
    if (!span) {
      continue;
    }
    const core = quoted ? value : value.slice(0, value.length - trailingPunctuationLength(value));
    if (
      core.length < MIN_GENERIC_SECRET_LENGTH ||
      core === REDACTION_PLACEHOLDER ||
      (!quoted && isReferenceValue(core))
    ) {
      continue;
    }
    const [start] = span;
    text += input.slice(lastIndex, start) + REDACTION_PLACEHOLDER;
    lastIndex = start + core.length;
    count++;
  }

  text += input.slice(lastIndex);
  return { text, count };
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

  const generic = redactGenericAssignments(scrubbed);
  scrubbed = generic.text;
  redactedCount += generic.count;

  return { scrubbed, redactedCount };
}
