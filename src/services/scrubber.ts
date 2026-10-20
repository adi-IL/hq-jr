/**
 * Patterns matching high-risk secrets and credentials.
 *
 * Known limitation: a regex only scrubber cannot tell a real credential from
 * an arbitrary string of the same shape. Tokens with an unexpected length
 * (ghp_ under 36 characters, github_pat_ that is not exactly 82, AIza that is
 * not exactly 35, generic values under 8 characters) are not redacted. An
 * unquoted generic value is kept when it reads configuration (process.env.X,
 * config.X, vault.read(...)); any other unquoted value is redacted. A call
 * with a root that is not a known accessor, such as getSecret(), is a literal
 * value and is redacted.
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
 * The bracket branch of the value reads a nested bracket as a bracket of its
 * own, so the branch stops at the next '[' that is not a nested read instead
 * of scanning the rest of the line for a ']' that may never come. An
 * unterminated bracket is then taken in one step by the second branch of the
 * value.
 */
const GENERIC_ASSIGNMENT_REGEX =
  /(?:["']?(?:password|passwd|api_key|apiKey|secret|private_token|client_secret|access_token|auth_token|refresh_token|api_secret)["']?)\s*[:=]\s*(?:(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1?|((?:\[(?:[^\[\]\r\n]|\[[^\[\]\r\n]*\])*\]|\[[^"'`\s]*|[^"'`\s])+))/dgi;

/**
 * An environment accessor, such as process.env, os.environ, this.env,
 * globalThis.env, Deno.env, Bun.env, import.meta.env or env. The accessor
 * has to stand on its own: a value that only starts with the same letters,
 * such as env-abc12345, is not an accessor.
 */
const ENV_ACCESSOR_REGEX =
  /^(?:(?:process|globalThis|global|Deno|Bun|this)\.env|os\.environ|(?:import\.meta\.)?env)(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^\]]*\]|$)/;

/** Shell and .env interpolation such as $DB_PASSWORD or ${DB_PASSWORD}. */
const ENV_INTERPOLATION_REGEX = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

/**
 * A member read, such as config.apiKey, credentials['api_key'] or
 * settings.db["primary"].password. A TypeScript member read keeps its
 * optional chaining (config?.apiKey) and its non-null assertion
 * (config.apiKey!), so those are part of the read as well.
 */
const MEMBER_EXPRESSION_REGEX =
  /^([A-Za-z_$][A-Za-z0-9_$]*)!?(?:(?:\?\.|\.)[A-Za-z_$][A-Za-z0-9_$]*|\[[^\]]*\])+!?$/;

/**
 * A call, such as os.getenv( or vault.read(. The first group is the root of
 * the call, the object the call is made on.
 */
const CALL_EXPRESSION_REGEX = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\(/;

/**
 * Roots of a call expression that read a value from somewhere else, such as
 * os.getenv( or Deno.env.get(. The configuration roots are known as well, so
 * config.getSecret( is code too. A call with any other root, such as
 * getSecret(, can be a literal value, so it is redacted.
 */
const CALL_ROOTS = new Set(["deno", "bun", "global", "globalthis", "os", "process"]);

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

/** A name of this length or longer can hold a random token. */
const MIN_TOKEN_LENGTH = 8;

/**
 * Length of the punctuation that closes the statement around an unquoted
 * value, such as the ";" in "apiKey = abc12345;". A closing bracket only
 * counts when it has no opening partner inside the value, so the "]" of
 * [REDACTED_SECRET] or of config["key"] stays part of the value.
 *
 * The counts of the characters ahead of the end are kept while the end moves
 * back, so a value that is nothing but closing brackets is scanned once
 * instead of once per bracket.
 */
function trailingPunctuationLength(value: string): number {
  let ahead: Map<string, number> | null = null;
  let end = value.length;
  while (end > 0) {
    const char = value[end - 1];
    if (char === ";" || char === ",") {
      end--;
      continue;
    }
    const opening = CLOSING_TO_OPENING[char];
    if (!opening) {
      break;
    }
    if (ahead === null) {
      ahead = new Map<string, number>();
      for (let index = 0; index < end; index++) {
        const aheadChar = value[index];
        ahead.set(aheadChar, (ahead.get(aheadChar) ?? 0) + 1);
      }
    }
    if ((ahead.get(char) ?? 0) > (ahead.get(opening) ?? 0)) {
      ahead.set(char, (ahead.get(char) ?? 0) - 1);
      end--;
      continue;
    }
    break;
  }
  return value.length - end;
}

/**
 * A name of at least eight characters that is all lowercase and holds both a
 * letter and a digit is a random token, such as abc12345, and not a name in
 * the source. A name in the source is written in upper case or in camel
 * case, so such a name is a credential.
 */
function isToken(name: string): boolean {
  return (
    name.length >= MIN_TOKEN_LENGTH &&
    !/[A-Z]/.test(name) &&
    /[a-z]/.test(name) &&
    /[0-9]/.test(name)
  );
}

/**
 * True when the value holds a random token. An environment variable is named
 * in upper case or in camel case, so a value such as env.abc12345 holds a
 * credential and not a name.
 */
function holdsTokenSegment(value: string): boolean {
  for (const segment of value.match(/[a-z0-9]+/g) ?? []) {
    if (isToken(segment)) {
      return true;
    }
  }
  return false;
}

/**
 * True when the value reads an environment variable, such as
 * process.env.SECRET_KEY or os.environ['CLIENT_SECRET'].
 */
function isEnvironmentReference(value: string): boolean {
  return ENV_ACCESSOR_REGEX.test(value) && !holdsTokenSegment(value);
}

/**
 * True when the value is a call on a known accessor, such as os.getenv( or
 * vault.read(. A call on any other root, such as getSecret(, can be a
 * literal value.
 */
function isKnownCall(value: string): boolean {
  const match = CALL_EXPRESSION_REGEX.exec(value);
  if (match === null) {
    return false;
  }
  const root = match[1];
  return CALL_ROOTS.has(root.toLowerCase()) || isReferenceRoot(root);
}

/**
 * An unquoted value that points at configuration instead of holding a
 * credential, such as process.env.SECRET_KEY or config.apiKey, is code the
 * reviewer needs to see untouched.
 */
function isReferenceValue(value: string): boolean {
  if (isEnvironmentReference(value) || ENV_INTERPOLATION_REGEX.test(value)) {
    return true;
  }
  if (isKnownCall(value)) {
    return true;
  }
  const member = MEMBER_EXPRESSION_REGEX.exec(value);
  if (member === null || !isReferenceRoot(member[1])) {
    return false;
  }
  // The root env names environment variables, so the property that follows it
  // has to be a name in the source and not a random token.
  return member[1].toLowerCase() !== "env" || !holdsTokenSegment(value);
}

function isReferenceRoot(root: string): boolean {
  if (REFERENCE_ROOTS.has(root.toLowerCase())) {
    return true;
  }
  // A root without a separator and without a capital in it is a single word,
  // so it cannot end with a known root.
  if (!/[A-Z_$]/.test(root)) {
    return false;
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
