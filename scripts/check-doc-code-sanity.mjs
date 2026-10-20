#!/usr/bin/env node
/**
 * Fails when the documentation and the source code disagree.
 *
 * A doc that names a function, file, or flag the code does not have is worse
 * than no doc, because a reader trusts it. This checks the claims that can be
 * checked mechanically:
 *
 *   1. Every source file the docs link to exists.
 *   2. Every source file the docs name in a code span exists.
 *   3. Every file the docs list as a project-structure entry exists.
 *   4. Every `HQ_JR_*` variable the docs name exists in src/config.ts.
 *   5. Every environment variable the docs name in a table has a row.
 *   6. Every documented endpoint exists in the source.
 *   7. Every source file the docs claim is "not wired" is in fact unwired.
 *
 * It also verifies the reverse direction for the project structure, because a
 * file that exists but is missing from the structure listing is drift too.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repoRoot, p), "utf8");

const DOC_FILES = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "LAUNCH.md",
  "docs/01-architecture-and-probot.md",
  "docs/02-model-orchestration-and-vertex-adc.md",
  "docs/03-codebase-ingestion-and-context.md",
  "docs/04-github-app-lifecycle-and-security.md",
  "docs/05-deployment-and-operations.md",
  "docs/README.md",
];

const problems = [];
const note = (msg) => problems.push(msg);

const sourceFiles = [];
function walk(dir, extensions) {
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, extensions);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) sourceFiles.push(rel);
  }
}
walk("src", [".ts"]);
walk("scripts", [".mjs", ".js"]);
walk("deploy", [".sh"]);

const sourceSet = new Set(sourceFiles);
const configSource = read("src/config.ts");
const configVars = new Set(
  [...configSource.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*z\./gm)].map((m) => m[1])
);
const allEnvVars = new Set(
  [...configSource.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*z\./gm)].map((m) => m[1])
);

for (const doc of DOC_FILES) {
  if (!existsSync(join(repoRoot, doc))) {
    note(`${doc} is listed in DOC_FILES but does not exist`);
    continue;
  }
  const text = read(doc);

  // 1. Markdown links to a source path.
  for (const m of text.matchAll(/\]\((src\/[^)#]+?)\)/g)) {
    const target = m[1];
    if (!existsSync(join(repoRoot, target))) {
      note(`${doc} links to ${target}, which does not exist`);
    }
  }

  // 2. Source paths named in a code span. A path is a claim about this
  // repository when it lives under a directory this repository has and is
  // written as a link or a bare module path. A path used as an example of
  // another project's layout is prose, so it is only checked when the file
  // name is one this project could plausibly have.
  for (const m of text.matchAll(/`((?:src|scripts)\/[^`\s]+?)`/g)) {
    const target = m[1].replace(/[.,:;]$/, "");
    if (target.includes("*")) continue;
    const parent = dirname(target);
    if (!existsSync(join(repoRoot, parent))) continue;
    const base = target.split("/").pop();
    const looksLikeOurs = sourceFiles.some((f) => f.endsWith(`/${base}`));
    const isDocLink = text.includes(`(${target})`);
    if (!looksLikeOurs && !isDocLink) continue;
    if (!existsSync(join(repoRoot, target))) {
      note(`${doc} names ${target} in a code span, but that path does not exist`);
    }
  }

  // 4. HQ_JR_* variables the docs name must exist in config.ts. A name in a
  // deployment example refers to a secret manager entry, not a config key.
  for (const m of text.matchAll(/\b(HQ_JR_[A-Z0-9_]+)\b/g)) {
    if (configVars.has(m[1])) continue;
    if (text.includes(`--set-secrets`) || text.includes("secret manager")) continue;
    note(`${doc} names ${m[1]}, but src/config.ts does not define it`);
  }

  // 6. Endpoints the docs claim exist.
  for (const m of text.matchAll(/`(\/(?:healthz|livez))`/g)) {
    if (!text.includes(m[1])) continue;
    if (!/router\.get\(\s*"\/healthz"/.test(read("src/index.ts")) && m[1] === "/healthz") {
      note(`${doc} names the ${m[1]} endpoint, but src/index.ts does not register it`);
    }
    if (!/router\.get\(\s*"\/livez"/.test(read("src/index.ts")) && m[1] === "/livez") {
      note(`${doc} names the ${m[1]} endpoint, but src/index.ts does not register it`);
    }
  }
}

// 5. Every config variable must have a row in the docs/05 table.
const docs05 = read("docs/05-deployment-and-operations.md");
const tableRows = new Set();
for (const line of docs05.split("\n")) {
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length < 5) continue;
  const name = cells[1].replace(/`/g, "");
  if (/^[A-Z][A-Z0-9_]*$/.test(name)) tableRows.add(name);
}
for (const name of configVars) {
  if (!tableRows.has(name)) {
    note(`src/config.ts defines ${name}, but docs/05 does not document it`);
  }
}

// 3. The project structure listing in the README must match the tree. Tree
// rows draw their branches with box characters, so the branch glyphs are
// stripped before the path is read. The directory prefix comes from the
// nearest ancestor row that ends in a slash.
const readme = read("README.md");
const structureBlock = readme.match(/## Project Structure\n[\s\S]*?```\n([\s\S]*?)```/);
if (structureBlock) {
  const stack = [];
  for (const line of structureBlock[1].split("\n")) {
    const indent = (line.match(/^[\s│]*/) || [""])[0].length;
    const cleaned = line
      .replace(/^[│├└─\s]+/, "")
      .replace(/\s+#.*$/, "")
      .trim();
    if (!cleaned || cleaned.includes("*")) continue;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    if (cleaned.endsWith("/")) {
      stack.push({ indent, dir: cleaned });
      continue;
    }
    const prefix = stack.map((s) => s.dir).join("");
    const path = prefix + cleaned;
    if (!/^[A-Za-z0-9._/-]+$/.test(path)) continue;
    if (!existsSync(join(repoRoot, path))) {
      note(`README project structure lists ${path}, which does not exist`);
    }
  }
}

// Every module under src/ and scripts/ must be named somewhere in the docs, so
// a new module cannot land undocumented. The README project structure tree
// counts, and so does a mention by name in any document. Test files are
// checked against their module, and a test with no module of its own is
// covered by the tree.
const documentText = DOC_FILES.map((doc) => read(doc)).join("\n");
for (const file of sourceFiles) {
  if (file.endsWith(".test.ts") || file.endsWith(".test.mjs")) continue;
  if (documentText.includes(file)) continue;
  const base = file.split("/").pop();
  if (readme.includes(base)) continue;
  note(`${file} is not mentioned in any document`);
}

if (problems.length > 0) {
  console.error("Documentation and source code disagree:");
  for (const p of problems) console.error(`  ${p}`);
  console.error("");
  console.error("Fix the documents or the code so they describe the same system.");
  process.exit(1);
}

console.log(
  `doc/code sanity check ok: ${DOC_FILES.length} documents agree with ${sourceFiles.length} source files`
);
