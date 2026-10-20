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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reads `NAME: z.<chain>.default(<literal>)` pairs out of the zod env schema.
 * The schema is one entry per line, so each line is matched on its own. A
 * variable whose default cannot be read as a string or a number is reported
 * as unreadable rather than skipped, so it can never pass the check silently.
 */
function readConfigDefaults() {
  const source = readFileSync(join(repoRoot, "src", "config.ts"), "utf8");
  const defaults = new Map();
  const unreadable = [];
  const entry = /^\s*([A-Z][A-Z0-9_]*):\s*z\..*?\.default\((.+)\),?\s*$/gm;
  for (const match of source.matchAll(entry)) {
    const [, name, raw] = match;
    let value = raw.trim().replace(/,$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else if (/^-?\d[\d_]*(\.\d+)?$/.test(value)) {
      value = value.replace(/_/g, "");
    } else {
      unreadable.push(name);
      continue;
    }
    defaults.set(name, value);
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
  for (const line of source.split("\n")) {
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
 * matching pair of quotes. Returns null when the line is an override in an
 * example, such as `PORT=8081 npm start`, rather than a documented default.
 */
function readValue(remainder) {
  let text = remainder.trim();
  if (!text) return "";

  // A quoted value keeps any hash inside it, so find the closing quote first.
  const quote = text[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const close = text.indexOf(quote, 1);
    if (close === -1) return null;
    return text.slice(1, close).trim();
  }

  // An unquoted value ends at the first hash, and the rest of the line must be
  // only a comment. Anything else continues into a command.
  const hash = text.indexOf("#");
  if (hash === -1) {
    return /\s/.test(text) ? null : text;
  }
  const after = text.slice(hash).trim();
  if (!after.startsWith("#")) return null;
  return text.slice(0, hash).trim();
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
 */
function readEnvBlockDefaults(file) {
  const source = readFileSync(join(repoRoot, file), "utf8");
  const defaults = new Map();
  const isDotenv = file.endsWith(".env") || file.endsWith(".env.example");
  const blocks = isDotenv
    ? [source]
    : [...source.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      const assignment = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!assignment) continue;
      const [, name, remainder] = assignment;
      // Split the value from a trailing comment, keeping a hash that is inside
      // a quoted value.
      const value = readValue(remainder);
      if (value === null) continue;
      defaults.set(name, value);
    }
  }
  return defaults;
}

const { defaults: config, unreadable: unreadableDefaults } = readConfigDefaults();
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
  for (const [name, value] of block) {
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
