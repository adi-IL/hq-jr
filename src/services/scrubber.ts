/**
 * Patterns matching high-risk secrets and credentials.
 *
 * Known limitation: a pattern only scrubber cannot tell a real credential from
 * an arbitrary string of the same shape. Tokens with an unexpected length
 * (ghp_ under 36 characters, github_pat_ that is not exactly 82, AIza that is
 * not exactly 35, generic values under 8 characters) are not redacted.
 * secret_key is the exception: its value is redacted at any length. An
 * unquoted generic value is kept when it reads configuration (process.env.X,
 * config.apiKey, vault.read(...)). A dotted or bracketed reference is a
 * secret when any segment looks like a token (config.abc12345,
 * users[abc12345]). A bracket read whose root is an identifier is code
 * (users[currentId], items[100]). A call with a root that is not a known
 * accessor, such as getSecret(), is a literal and is redacted. A call that
 * passes a literal secret, such as os.getenv("super-secret-value"), is a
 * literal too. A broken bracket value, such as [abcdefgh[i jkl], is a literal
 * and is redacted whole, whatever its length. The value is one span, read
 * forward to the end of the statement, so a call argument and the indented
 * lines of a block scalar are classified with the value and not on their own.
 * A quoted string is scanned for an assignment. A quote in a comment, and an
 * unpaired quote, does not hide the rest of the line. A block scalar keeps
 * the line break after its body, and an empty scalar does not take the next key.
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

  // AWS Secret Access Key (heuristics near keywords). secret_key is not here:
  // a fixed 40 character capture leaves the rest of a longer value in place.
  /(?:aws_secret_access_key|aws_access_key_id)\s*[:=]\s*["'`]?([A-Za-z0-9/+=]{40})["'`]?/gi,

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
 * The keys whose value holds a secret, longest first, already lower case.
 * A key matches as a whole word, so secret_key is not read as secret.
 * apiKey is stored lower case because the match is case insensitive.
 */
const SECRET_KEY_NAMES = [
  "connection_string",
  "refresh_token",
  "private_token",
  "client_secret",
  "database_url",
  "access_token",
  "private_key",
  "secret_key",
  "auth_token",
  "api_secret",
  "api-token",
  "password",
  "api_key",
  "api-key",
  "apikey",
  "passwd",
  "secret",
  "token",
];

/** secret_key is redacted at any length. The 8 character floor does not apply. */
function redactsAtAnyLength(key: string): boolean {
  return key === "secret_key";
}

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

/** A name of this length or longer can hold a random token. */
const MIN_TOKEN_LENGTH = 8;

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
 * True when the value holds a random token. A name in the source is written
 * in upper case or in camel case, so a segment such as abc12345 is a
 * credential on every reference root, not only on env.
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
 * A quoted argument that is not a name in the source. An identifier is a
 * name (DB_PASSWORD, secret). A token, or any other long literal such as
 * super-secret-value, is a credential passed into the call.
 */
function argumentIsLiteralSecret(inner: string): boolean {
  if (isToken(inner)) {
    return true;
  }
  if (inner.length < MIN_GENERIC_SECRET_LENGTH) {
    return false;
  }
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner);
}

/** True when a call passes a literal secret rather than a name. */
function callHoldsLiteralSecret(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    const quote = value[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      index++;
      continue;
    }
    let cursor = index + 1;
    while (cursor < value.length) {
      const char = value[cursor];
      if (char === "\\") {
        cursor += 2;
        continue;
      }
      if (char === quote || char === "\n" || char === "\r") {
        break;
      }
      cursor++;
    }
    if (
      cursor < value.length &&
      value[cursor] === quote &&
      argumentIsLiteralSecret(value.slice(index + 1, cursor))
    ) {
      return true;
    }
    index = cursor + 1;
  }
  return false;
}

/**
 * A bracket read whose root is an identifier, such as users[currentId] or
 * items[100]. A root that contains a digit, such as hunter2["abc"], is a
 * credential shaped root and is not code. The match has to cover the whole
 * value, so a nested bracket such as config[a[b]] is not a bracket read.
 */
function isIdentifierBracketRead(value: string): boolean {
  if (!value.includes("[")) {
    return false;
  }
  const member = MEMBER_EXPRESSION_REGEX.exec(value);
  if (member === null) {
    return false;
  }
  return !/[0-9]/.test(member[1]);
}

/**
 * An unquoted value that points at configuration instead of holding a
 * credential, such as process.env.SECRET_KEY or config.apiKey, is code the
 * reviewer needs to see untouched. A reference whose any segment looks like
 * a token is a secret. A known call that is handed a literal secret is a
 * secret as well.
 */
function isReferenceValue(value: string): boolean {
  if (isEnvironmentReference(value) || ENV_INTERPOLATION_REGEX.test(value)) {
    return true;
  }
  if (isKnownCall(value)) {
    return !callHoldsLiteralSecret(value);
  }
  if (isIdentifierBracketRead(value)) {
    return !holdsTokenSegment(value);
  }
  const member = MEMBER_EXPRESSION_REGEX.exec(value);
  if (member === null || !isReferenceRoot(member[1])) {
    return false;
  }
  return !holdsTokenSegment(value);
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
 * True when the value is a bracket expression whose brackets do not balance,
 * such as [abcdefgh[i jkl] or [a[b c]. A broken bracket is not a reference to
 * a configuration value, so it is a literal and has to be redacted. A lone
 * opening bracket is an expression that was not finished, not a value, so it
 * is left alone.
 */
function isBrokenBracketLiteral(value: string): boolean {
  if (!value.startsWith("[")) {
    return false;
  }
  let depth = 0;
  let material = 0;
  for (const char of value) {
    if (char === "[") {
      depth++;
    } else if (char === "]") {
      if (depth === 0) {
        return true;
      }
      depth--;
    } else {
      material++;
    }
  }
  return depth !== 0 && material > 0;
}

/** The value of an assignment, read as one span. */
interface ValueSpan {
  /** The text of the value. */
  text: string;
  /** The index of the first character of the value. */
  start: number;
  /** The index after the last character of the value. */
  end: number;
}

/** A secret key and the index where its value starts. */
interface AssignmentHit {
  key: string;
  /** The index of the first value character, or text.length when there is none. */
  valueStart: number;
  /** The index just after the separator, used when the value is empty. */
  resumeAt: number;
}

/**
 * A space or a tab, the white space that stays inside a line. A line break
 * ends the value on its own.
 */
function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\v" || char === "\f";
}

function isWordChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "_"
  );
}

function isLineBreak(char: string | undefined): boolean {
  return char === "\n" || char === "\r";
}

/** Lower case comparison of a fixed key. The key list is already lower case. */
function startsWithKey(text: string, index: number, key: string): boolean {
  if (index + key.length > text.length) {
    return false;
  }
  for (let offset = 0; offset < key.length; offset++) {
    let char = text[index + offset];
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      char = String.fromCharCode(code + 32);
    }
    if (char !== key[offset]) {
      return false;
    }
  }
  return true;
}

function skipSpacesOnly(text: string, index: number, limit: number = text.length): number {
  let cursor = index;
  while (cursor < limit && isSpace(text[cursor])) {
    cursor++;
  }
  return cursor;
}

/**
 * The index after a closing quote that follows a key. The closer is the
 * quote itself, or a backslash and the quote when the assignment is escaped
 * inside a string.
 */
function closingQuoteEnd(text: string, after: number, quote: string, limit: number): number {
  if (after < limit && text[after] === quote) {
    return after + 1;
  }
  if (after + 1 < limit && text[after] === "\\" && text[after + 1] === quote) {
    return after + 2;
  }
  return -1;
}

/**
 * A secret assignment at this index, or null. A quoted key has to be the
 * whole quoted word, so a banner such as "password = " is not an assignment.
 * The scan is forward only.
 */
function matchAssignmentAt(text: string, index: number, limit: number = text.length): AssignmentHit | null {
  if (index < 0 || index >= limit) {
    return null;
  }
  const quote = text[index];
  const quoted = quote === '"' || quote === "'";
  const keyStart = quoted ? index + 1 : index;
  // A leading underscore is a separator (DB_PASSWORD). A letter or digit is not.
  if (!quoted && index > 0 && text[index - 1] !== "_" && isWordChar(text[index - 1])) {
    return null;
  }
  let key: string | null = null;
  let cursor = 0;
  for (const candidate of SECRET_KEY_NAMES) {
    if (!startsWithKey(text, keyStart, candidate)) {
      continue;
    }
    const after = keyStart + candidate.length;
    if (quoted) {
      const closedAt = closingQuoteEnd(text, after, quote, limit);
      if (closedAt < 0) {
        continue;
      }
      cursor = closedAt;
    } else if (after < limit && isWordChar(text[after])) {
      continue;
    } else {
      cursor = after;
    }
    key = candidate;
    break;
  }
  if (key === null) {
    return null;
  }
  cursor = skipSpacesOnly(text, cursor, limit);
  if (cursor >= limit || !isAssignmentOperator(text, cursor, limit)) {
    return null;
  }
  const resumeAt = cursor + operatorLength(text, cursor);
  return { key, valueStart: skipSpacesOnly(text, resumeAt, limit), resumeAt };
}

/**
 * True when the text at index starts an assignment.
 *
 * A bare equals sign is an assignment. A comparison is not: `==` and `===` are
 * comparisons, and an arrow function `=>` is not an assignment either. A colon
 * is an assignment only when it is a YAML key separator, so `:=` is a Go short
 * variable declaration and not an assignment.
 */
function operatorLength(text: string, index: number): number {
  return text[index] === ":" && text[index + 1] === "=" ? 2 : 1;
}

function isAssignmentOperator(text: string, index: number, limit: number): boolean {
  const char = text[index];
  if (char === "=") {
    const next = text[index + 1];
    if (next === "=" || next === ">") return false;
    return true;
  }
  if (char === ":") {
    // A Go short variable declaration assigns, so its value is still a value.
    // A bare colon is a YAML key separator, which also introduces a value.
    return true;
  }
  return false;
}

/**
 * The index after a string that starts at index. The string ends at its
 * close quote or at the line break. Used so a key inside a banner is not
 * classified as its own assignment.
 */
function skipString(text: string, start: number, limit: number = text.length): number {
  const quote = text[start];
  let index = start + 1;
  while (index < limit) {
    const char = text[index];
    if (char === "\\") {
      index += index + 1 < limit ? 2 : 1;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    if (isLineBreak(char)) {
      return index;
    }
    index++;
  }
  return index;
}

/** True when skipString stopped on the matching quote rather than a line break. */
function stringClosed(text: string, start: number, end: number): boolean {
  return end > start + 1 && text[end - 1] === text[start];
}

/**
 * True when the value opens a YAML block scalar. The indicator is | or >,
 * with an optional chomp marker or indent number, and the line ends there.
 */
function isBlockScalarStart(text: string, start: number, limit: number = text.length): boolean {
  const indicator = text[start];
  if (indicator !== "|" && indicator !== ">") {
    return false;
  }
  let index = start + 1;
  if (index < limit && (text[index] === "+" || text[index] === "-")) {
    index++;
  }
  while (index < limit && text[index] >= "0" && text[index] <= "9") {
    index++;
  }
  index = skipSpacesOnly(text, index, limit);
  if (index < limit && text[index] === "#") {
    while (index < limit && !isLineBreak(text[index])) {
      index++;
    }
  }
  return index >= limit || isLineBreak(text[index]);
}

/** How far the line containing index is indented. */
function lineIndent(text: string, index: number): number {
  let lineStart = index;
  while (lineStart > 0 && !isLineBreak(text[lineStart - 1])) {
    lineStart--;
  }
  let indent = 0;
  while (text[lineStart] === " " || text[lineStart] === "\t") {
    indent++;
    lineStart++;
  }
  return indent;
}

/**
 * The indented lines that follow a block scalar indicator. A less indented
 * line ends the block. Each line is visited once.
 */
function readBlockScalar(text: string, start: number, limit: number = text.length): ValueSpan {
  const parentIndent = lineIndent(text, start);
  let index = start;
  while (index < limit && !isLineBreak(text[index])) {
    index++;
  }
  if (index < limit && text[index] === "\r") {
    index++;
  }
  if (index < limit && text[index] === "\n") {
    index++;
  }
  let contentIndent = -1;
  while (index < limit) {
    let line = index;
    let indent = 0;
    while (line < limit && (text[line] === " " || text[line] === "\t")) {
      indent++;
      line++;
    }
    if (line >= limit) {
      index = line;
      break;
    }
    if (isLineBreak(text[line])) {
      if (text[line] === "\r" && line < limit) {
        line++;
      }
      if (line < limit && text[line] === "\n") {
        line++;
      }
      index = line;
      continue;
    }
    // A line at or above the key is the next statement, not scalar content.
    if (indent <= parentIndent) {
      break;
    }
    if (contentIndent === -1) {
      contentIndent = indent;
    }
    if (indent < contentIndent) {
      break;
    }
    while (line < limit && !isLineBreak(text[line])) {
      line++;
    }
    if (line < limit && text[line] === "\r") {
      line++;
    }
    if (line < limit && text[line] === "\n") {
      line++;
    }
    index = line;
  }
  // The line break that ends the scalar stays in the text, so the next key
  // keeps its own line.
  if (index > start && text[index - 1] === "\n") {
    index--;
  }
  if (index > start && text[index - 1] === "\r") {
    index--;
  }
  return { text: text.slice(start, index), start, end: index };
}

/** The body of a block scalar, without the indicator line or surrounding space. */
function blockScalarContent(span: string): string {
  const newline = span.indexOf("\n");
  if (newline < 0) {
    return "";
  }
  return span.slice(newline + 1).trim();
}

/**
 * The interior of a span that is one quoted string, or null when the span is
 * anything else. The quotes themselves stay in the output.
 */
function quotedInterior(span: string): string | null {
  if (span.length < 2) {
    return null;
  }
  const quote = span[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || span[span.length - 1] !== quote) {
    return null;
  }
  for (let index = 1; index < span.length - 1; index++) {
    if (span[index] === "\\") {
      index++;
      continue;
    }
    if (span[index] === quote || isLineBreak(span[index])) {
      return null;
    }
  }
  return span.slice(1, -1);
}

/** A value that is an escaped quoted string, such as \"supersecret\". */
function readEscapedQuoted(text: string, start: number, limit: number): ValueSpan | null {
  if (start + 1 >= limit || text[start] !== "\\") {
    return null;
  }
  const quote = text[start + 1];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return null;
  }
  let cursor = start + 2;
  while (cursor < limit) {
    if (text[cursor] === "\\" && cursor + 1 < limit) {
      if (text[cursor + 1] === quote) {
        const end = cursor + 2;
        return { text: text.slice(start, end), start, end };
      }
      cursor += 2;
      continue;
    }
    if (isLineBreak(text[cursor])) {
      break;
    }
    cursor++;
  }
  return null;
}

/**
 * Reads one candidate value, forward only, until the newline that ends the
 * statement or the next secret assignment. Quotes, calls and brackets are
 * part of the span. A block scalar also includes its indented lines.
 * A quoted value ends at its close quote, so text after it stays in place.
 * A semicolon or comma ends the value only when it ends the statement.
 */
function readValueSpan(text: string, start: number, limit: number = text.length): ValueSpan {
  if (start >= limit) {
    return { text: "", start, end: start };
  }
  if (isBlockScalarStart(text, start, limit)) {
    return readBlockScalar(text, start, limit);
  }
  const escaped = readEscapedQuoted(text, start, limit);
  if (escaped !== null) {
    return escaped;
  }
  const opener = text[start];
  if (opener === '"' || opener === "'" || opener === "`") {
    const end = skipString(text, start, limit);
    return { text: text.slice(start, end), start, end };
  }
  let index = start;
  let depth = 0;
  let quote: string | null = null;
  while (index < limit) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\") {
        index += index + 1 < limit ? 2 : 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        index++;
        continue;
      }
      if (isLineBreak(char)) {
        break;
      }
      index++;
      continue;
    }
    if (isLineBreak(char)) {
      break;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      index++;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth++;
      index++;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) {
        break;
      }
      depth--;
      index++;
      continue;
    }
    if (depth === 0 && (char === ";" || char === ",")) {
      const after = index + 1;
      const next = skipSpacesOnly(text, after, limit);
      const followedBySpace = after < limit && isSpace(text[after]);
      const statementEnd =
        next >= limit ||
        isLineBreak(text[next]) ||
        text[next] === ")" ||
        text[next] === "]" ||
        text[next] === "}" ||
        followedBySpace ||
        matchAssignmentAt(text, next, limit) !== null;
      if (statementEnd) {
        break;
      }
      index++;
      continue;
    }
    if (isSpace(char)) {
      const next = skipSpacesOnly(text, index, limit);
      if (next >= limit || isLineBreak(text[next]) || matchAssignmentAt(text, next, limit) !== null) {
        break;
      }
      index = next;
      continue;
    }
    index++;
  }
  // A semicolon or comma after a broken bracket is statement punctuation.
  // Depth stays above zero there, so it is not a stopping point above, and
  // it has to be peeled off the end or the placeholder swallows it.
  let end = index;
  while (end > start && (text[end - 1] === ";" || text[end - 1] === ",")) {
    end--;
  }
  return { text: text.slice(start, end), start, end };
}

function literalIsSecret(literal: string, key: string): boolean {
  if (literal.length === 0 || literal === REDACTION_PLACEHOLDER) {
    return false;
  }
  if (redactsAtAnyLength(key)) {
    return true;
  }
  return literal.length >= MIN_GENERIC_SECRET_LENGTH;
}

/**
 * The body of an escaped quoted span (\"secret\"), or null when the span is
 * any other shape. The escaped quotes stay in the output.
 */
function escapedQuotedBody(span: string): string | null {
  if (span.length < 4 || span[0] !== "\\") {
    return null;
  }
  const quote = span[1];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || span[span.length - 2] !== "\\" || span[span.length - 1] !== quote) {
    return null;
  }
  return span.slice(2, -2);
}

/**
 * The range to replace, or null when the candidate is code or too short to
 * be a credential. A quoted literal is replaced inside its quotes. Anything
 * else is replaced as a whole span.
 */
function redactRange(span: ValueSpan, key: string): { start: number; end: number } | null {
  const raw = span.text;
  if (raw.length === 0 || raw === REDACTION_PLACEHOLDER) {
    return null;
  }
  if (isBlockScalarStart(raw, 0)) {
    const content = blockScalarContent(raw);
    if (
      content.length === 0 ||
      content === REDACTION_PLACEHOLDER ||
      isReferenceValue(content) ||
      ENV_INTERPOLATION_REGEX.test(content) ||
      !literalIsSecret(content, key)
    ) {
      return null;
    }
    return { start: span.start, end: span.end };
  }
  const escapedBody = escapedQuotedBody(raw);
  if (escapedBody !== null) {
    if (!literalIsSecret(escapedBody, key)) {
      return null;
    }
    return { start: span.start + 2, end: span.end - 2 };
  }
  const interior = quotedInterior(raw);
  if (interior !== null) {
    if (!literalIsSecret(interior, key)) {
      return null;
    }
    return { start: span.start + 1, end: span.end - 1 };
  }
  if (isReferenceValue(raw)) {
    return null;
  }
  if (isBrokenBracketLiteral(raw) || literalIsSecret(raw, key)) {
    return { start: span.start, end: span.end };
  }
  return null;
}

function findLineEnd(text: string, index: number, limit: number): number {
  while (index < limit && !isLineBreak(text[index])) {
    index++;
  }
  return index;
}

function findBlockCommentEnd(text: string, index: number, limit: number): number {
  let cursor = index + 2;
  while (cursor + 1 < limit) {
    if (text[cursor] === "*" && text[cursor + 1] === "/") {
      return cursor + 2;
    }
    cursor++;
  }
  return limit;
}

function isLineCommentStart(text: string, index: number, limit: number): boolean {
  return index + 1 < limit && text[index] === "/" && text[index + 1] === "/";
}

function isBlockCommentStart(text: string, index: number, limit: number): boolean {
  return index + 1 < limit && text[index] === "/" && text[index + 1] === "*";
}

/** A hash comment starts a line, or follows only spaces on that line. */
function isHashCommentStart(text: string, index: number): boolean {
  if (text[index] !== "#") {
    return false;
  }
  let cursor = index - 1;
  while (cursor >= 0 && !isLineBreak(text[cursor])) {
    if (!isSpace(text[cursor])) {
      return false;
    }
    cursor--;
  }
  return true;
}

/**
 * Redacts assignments in [start, end). A comment is scanned with inComment
 * set, so a quote there is not the start of a string. Each index is visited
 * a constant number of times.
 */
function redactRegion(
  input: string,
  start: number,
  end: number,
  inComment: boolean
): { text: string; count: number } {
  let text = "";
  let last = start;
  let count = 0;
  let index = start;

  while (index < end) {
    if (!inComment && (isLineCommentStart(input, index, end) || isHashCommentStart(input, index))) {
      const lineEnd = findLineEnd(input, index, end);
      const inner = redactRegion(input, index, lineEnd, true);
      text += input.slice(last, index) + inner.text;
      last = lineEnd;
      count += inner.count;
      index = lineEnd;
      continue;
    }
    if (!inComment && isBlockCommentStart(input, index, end)) {
      const blockEnd = findBlockCommentEnd(input, index, end);
      const inner = redactRegion(input, index, blockEnd, true);
      text += input.slice(last, index) + inner.text;
      last = blockEnd;
      count += inner.count;
      index = blockEnd;
      continue;
    }

    const char = input[index];
    if (
      !inComment &&
      (char === '"' || char === "'" || char === "`") &&
      matchAssignmentAt(input, index, end) === null
    ) {
      const stringEnd = skipString(input, index, end);
      if (!stringClosed(input, index, stringEnd)) {
        index++;
        continue;
      }
      const closer = stringEnd - 1;
      if (closer !== index && matchAssignmentAt(input, closer, end) !== null) {
        index = closer;
        continue;
      }
      const inner = redactRegion(input, index + 1, closer, false);
      text += input.slice(last, index + 1) + inner.text;
      last = closer;
      count += inner.count;
      index = stringEnd;
      continue;
    }

    const assignment = matchAssignmentAt(input, index, end);
    if (assignment === null) {
      index++;
      continue;
    }
    if (assignment.valueStart >= end || isLineBreak(input[assignment.valueStart])) {
      index = Math.max(assignment.resumeAt, index + 1);
      if (index > end) {
        index = end;
      }
      continue;
    }
    const span = readValueSpan(input, assignment.valueStart, end);
    if (span.end <= index) {
      index++;
      continue;
    }
    const range = redactRange(span, assignment.key);
    if (range === null) {
      index = span.end;
      continue;
    }
    text += input.slice(last, range.start) + REDACTION_PLACEHOLDER;
    last = range.end;
    count++;
    index = span.end;
  }

  text += input.slice(last, end);
  return { text, count };
}

/**
 * Replaces the value of each generic secret assignment with the placeholder.
 * The scan walks forward once. A value is classified once, so a key inside
 * a value is not a second assignment.
 */
function redactGenericAssignments(input: string): { text: string; count: number } {
  return redactRegion(input, 0, input.length, false);
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
