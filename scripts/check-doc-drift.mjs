#!/usr/bin/env node
/**
 * Fails when the documented environment variables drift from src/config.ts.
 *
 * The env var table in docs/05 and the env block in README are hand-written.
 * A variable added to config.ts but not to the docs is invisible to an
 * operator, and a variable documented with the wrong default sends them to
 * the wrong model. This reads the real defaults out of config.ts and compares
 * them against both documents.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Drops line and block comments so a commented out call is not read as code.
 * Strings are left intact. An unclosed block comment hides the rest of the
 * entry, so the caller treats that as unreadable rather than absent.
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < source.length) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Reads the argument of the first `.default(...)` in a schema entry. The
 * argument may span lines. Comments are ignored first, so a commented out
 * call is not the default. An unclosed call is unreadable, not absent.
 */
function readDefaultArgument(body) {
  const source = stripComments(body);
  if (source === null) return { kind: "unreadable" };
  const at = source.indexOf(".default(");
  if (at === -1) return { kind: "none" };
  let i = at + ".default(".length;
  let depth = 1;
  let quote = null;
  let arg = "";
  while (i < source.length) {
    const c = source[i];
    if (quote) {
      arg += c;
      if (c === "\\" && i + 1 < source.length) {
        arg += source[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      arg += c;
      i++;
      continue;
    }
    if (c === "(") {
      depth++;
      arg += c;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) break;
      arg += c;
      i++;
      continue;
    }
    arg += c;
    i++;
  }
  if (depth !== 0 || quote) return { kind: "unreadable" };
  return interpretDefault(arg.trim());
}

/**
 * Decodes a JavaScript string body the way a string literal does. A sequence
 * that is not a strict-mode escape is unreadable, because comparing the
 * source characters would not compare the runtime value.
 */
function decodeJsString(inner) {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\") {
      out += inner[i];
      continue;
    }
    if (i + 1 >= inner.length) return null;
    const n = inner[i + 1];
    const simple = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "`": "`",
    };
    if (Object.prototype.hasOwnProperty.call(simple, n)) {
      out += simple[n];
      i += 1;
      continue;
    }
    if (n === "0" && (i + 2 >= inner.length || !/[0-9]/.test(inner[i + 2]))) {
      out += "\0";
      i += 1;
      continue;
    }
    if (n === "x" && /^[0-9A-Fa-f]{2}$/.test(inner.slice(i + 2, i + 4))) {
      out += String.fromCharCode(parseInt(inner.slice(i + 2, i + 4), 16));
      i += 3;
      continue;
    }
    if (n === "u" && inner[i + 2] === "{") {
      const end = inner.indexOf("}", i + 3);
      if (end === -1) return null;
      const hex = inner.slice(i + 3, end);
      if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return null;
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff) return null;
      out += String.fromCodePoint(cp);
      i = end;
      continue;
    }
    if (n === "u" && /^[0-9A-Fa-f]{4}$/.test(inner.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(inner.slice(i + 2, i + 6), 16));
      i += 5;
      continue;
    }
    if (n === "\n") {
      i += 1;
      continue;
    }
    if (n === "\r") {
      i += inner[i + 2] === "\n" ? 2 : 1;
      continue;
    }
    if (/[0-9xu]/.test(n)) return null;
    out += n;
    i += 1;
  }
  return out;
}

function hasTemplateSubstitution(inner) {
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\") {
      i += 1;
      continue;
    }
    if (inner[i] === "$" && inner[i + 1] === "{") return true;
  }
  return false;
}

function interpretDefault(value) {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
    (value.startsWith("`") && value.endsWith("`") && value.length >= 2)
  ) {
    const inner = value.slice(1, -1);
    if (value.startsWith("`") && hasTemplateSubstitution(inner)) return { kind: "unreadable" };
    const decoded = decodeJsString(inner);
    if (decoded === null) return { kind: "unreadable" };
    return { kind: "value", value: decoded };
  }
  if (/^-?\d[\d_]*(\.\d+)?$/.test(value)) {
    return { kind: "value", value: value.replace(/_/g, "") };
  }
  if (value === "true" || value === "false") return { kind: "value", value };
  return { kind: "unreadable" };
}

/**
 * Reads `NAME: z....default(<literal>)` pairs out of the zod env schema.
 * A variable whose default cannot be read as a string, number, or boolean is
 * reported as unreadable rather than skipped, including when the default is
 * split across lines or followed by a comment.
 */
export function readConfigDefaults(source) {
  const defaults = new Map();
  const unreadable = [];
  const keyRe = /^[ \t]*([A-Z][A-Z0-9_]*):[ \t]*z\b/gm;
  const keys = [...source.matchAll(keyRe)];
  for (let n = 0; n < keys.length; n++) {
    const name = keys[n][1];
    const start = keys[n].index + keys[n][0].length;
    const end = n + 1 < keys.length ? keys[n + 1].index : source.length;
    const parsed = readDefaultArgument(source.slice(start, end));
    if (parsed.kind === "none") continue;
    if (parsed.kind === "unreadable") {
      unreadable.push(name);
      continue;
    }
    defaults.set(name, parsed.value);
  }
  return { defaults, unreadable };
}

/** Reads the docs/05 env var table. Cells are split on `|` and unwrapped. */
function readDocsTableDefaults() {
  const source = readFileSync(
    join(repoRoot, "docs", "05-deployment-and-operations.md"),
    "utf8"
  );
  const defaults = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    // Cells are [empty, name, required, default, description, empty].
    if (cells.length < 5) continue;
    const name = cells[1].replace(/`/g, "");
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    const raw = cells[3].replace(/`/g, "").trim();
    defaults.set(name, raw === "none" ? "" : raw);
  }
  return defaults;
}

/**
 * Reads the value part of an assignment, stripping a trailing comment and a
 * matching pair of quotes.
 *
 * Returns `{ skip: true }` when the line is an override in an example, such
 * as `PORT=8081 npm start`, rather than a documented default.
 * Returns `{ malformed: true }` when a quote is opened and not closed. A
 * malformed value is a drift even if the text after the quote matches the
 * default. Skipping it would let a changed value evade the check.
 */
export function readValue(remainder) {
  const text = remainder.trim();
  if (!text) return { value: "" };

  const quote = text[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const close = text.indexOf(quote, 1);
    if (close === -1) return { malformed: true, value: text.slice(1).trim() };
    const value = text.slice(1, close).trim();
    const after = text.slice(close + 1).trim();
    if (after !== "" && !after.startsWith("#")) return { malformed: true, value };
    return { value };
  }

  // An unquoted value ends at the first hash, and the rest of the line must be
  // only a comment. Anything else continues into a command.
  const hash = text.indexOf("#");
  if (hash === -1) {
    return /\s/.test(text) ? { skip: true } : { value: text };
  }
  const after = text.slice(hash).trim();
  if (!after.startsWith("#")) return { skip: true };
  return { value: text.slice(0, hash).trim() };
}

/**
 * Reads `NAME=value` lines out of an environment block.
 *
 * A fenced block is read as a whole, so a command elsewhere in the file such
 * as `PORT=8081 npm start` is not mistaken for a documented default. The fence
 * must be followed by a newline, otherwise a closing fence pairs with the next
 * opening fence and the block in between is read instead of the intended one.
 *
 * A dotenv file is read directly, because it has no fences. A trailing comment
 * after a value is stripped, so `NAME=value # note` still records the value.
 * A line that continues into a command is an override in an example, not a
 * documented default, so it is skipped.
 *
 * A value may be quoted, as a dotenv file commonly does. The quotes are
 * stripped, so a quoted value compares equal to the unquoted default.
 *
 * An assignment with an EMPTY value is recorded as empty rather than being
 * skipped. A variable whose default is not empty and whose example value is
 * empty is a drift, and skipping it would let the check pass.
 *
 * An unmatched quote is returned as malformed and is not compared. A fenced
 * file with an opening fence that never closes is reported, including when an
 * earlier block closed cleanly. Leaving that block unread would let its
 * assignments skip the check.
 */
export function readEnvBlockDefaultsFrom(source, file) {
  const defaults = new Map();
  const malformed = [];
  const isDotenv = file.endsWith(".env") || file.endsWith(".env.example");
  const fencePattern = () => /^```[a-z]*\r?\n([\s\S]*?)^```\r?$/gm;
  const blocks = isDotenv ? [source] : [...source.matchAll(fencePattern())].map((m) => m[1]);
  const blocksUnreadable = !isDotenv && /^```/m.test(source.replace(fencePattern(), ""));
  for (const block of blocks) {
    for (const line of block.split(/\r?\n/)) {
      const assignment = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!assignment) continue;
      const [, name, remainder] = assignment;
      const parsed = readValue(remainder);
      if (parsed.skip) continue;
      if (parsed.malformed) {
        malformed.push(name);
        continue;
      }
      defaults.set(name, parsed.value);
    }
  }
  return { defaults, malformed, blocksUnreadable };
}

function readEnvBlockDefaults(file) {
  return readEnvBlockDefaultsFrom(readFileSync(join(repoRoot, file), "utf8"), file);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  const { defaults: config, unreadable: unreadableDefaults } = readConfigDefaults(
    readFileSync(join(repoRoot, "src", "config.ts"), "utf8")
  );
  const docs = readDocsTableDefaults();
  const readme = readEnvBlockDefaults("README.md");
  const envExample = readEnvBlockDefaults(".env.example");

  /**
   * Variables that are deliberately not in the zod schema. The Probot ones are
   * consumed by Probot itself, GOOGLE_APPLICATION_CREDENTIALS by the ADC
   * library, and HOST is read by Probot's server.
   */
  const EXTERNAL_VARS = new Set([
    "APP_ID",
    "PRIVATE_KEY",
    "WEBHOOK_SECRET",
    "WEBHOOK_PROXY_URL",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "HOST",
  ]);

  /**
   * Values that are placeholders in an example file rather than the real
   * default, so they are not compared.
   */
  const PLACEHOLDER_VALUES = new Set([
    "your-gcp-project-id",
    "your-google-cloud-project-id",
    "your-webhook_secret",
    "your_smee_channel",
    "123456",
    "your-smee-channel",
    "your_smee_channel_id",
  ]);

  const problems = [];

  // A variable whose default this script cannot read is a gap in the check, not
  // a variable that is allowed to skip it. Report it so the script cannot pass
  // while silently ignoring a schema entry.
  for (const name of unreadableDefaults) {
    problems.push(
      `src/config.ts defines ${name} but its default could not be read, so it is not checked against the docs`
    );
  }

  // Every documented variable must exist in config.ts with the same default.
  for (const [name, documented] of docs) {
    if (EXTERNAL_VARS.has(name)) continue;
    if (!config.has(name)) {
      problems.push(`docs/05 documents ${name} but src/config.ts does not define it`);
      continue;
    }
    if (config.get(name) !== documented) {
      problems.push(
        `docs/05 says ${name} defaults to '${documented}' but src/config.ts says '${config.get(name)}'`
      );
    }
  }

  // Every variable in config.ts must be documented in the docs/05 table.
  for (const name of config.keys()) {
    if (!docs.has(name)) {
      problems.push(`src/config.ts defines ${name} but docs/05 does not document it`);
    }
  }

  // README and .env.example must not contradict config.ts.
  for (const [label, block] of [
    ["README.md", readme],
    [".env.example", envExample],
  ]) {
    if (block.blocksUnreadable) {
      problems.push(
        `${label} has fenced blocks that could not be read, so its assignments were not checked`
      );
    }
    for (const name of block.malformed) {
      problems.push(`${label} has a malformed value for ${name}, so it was not compared`);
    }
    for (const [name, value] of block.defaults) {
      if (!config.has(name)) continue;
      if (PLACEHOLDER_VALUES.has(value)) continue;
      if (config.get(name) !== value) {
        problems.push(
          `${label} sets ${name}=${value} but src/config.ts defaults it to '${config.get(name)}'`
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error("Documented environment variables drifted from src/config.ts:");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("");
    console.error("Fix the documents or the schema so they agree, then re-run this script.");
    process.exit(1);
  }

  console.log(
    `doc drift check ok: ${config.size} config variables agree with docs/05, README.md, and .env.example`
  );
  }

if (invokedDirectly()) main();
