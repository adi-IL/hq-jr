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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
    // Paths are compared against paths that come from the documents, which
    // always use forward slashes. Normalise here so the comparison holds on
    // Windows, where join() would produce backslashes.
    const rel = `${dir}/${entry.name}`;
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
  // repository when it is written as a link, or when its first directory
  // segment is one this repository owns and the file name matches a module
  // of this repository. A path used as an example of another project's
  // layout is prose, so it is skipped unless it names a module of this
  // project.
  const OWNED_ROOTS = new Set([
    ...sourceFiles.map((f) => f.split("/")[0]),
    "src",
    "scripts",
    "deploy",
  ]);
  for (const m of text.matchAll(/`((?:src|scripts|deploy)\/[^`\s]+?)`/g)) {
    const target = m[1].replace(/[.,:;]$/, "");
    if (target.includes("*")) continue;
    const base = target.split("/").pop();
    const isDocLink = text.includes(`(${target})`);
    const nameMatches = sourceFiles.some((f) => f.split("/").pop() === base);
    const root = target.split("/")[0];
    if (!isDocLink && !nameMatches) continue;
    if (!OWNED_ROOTS.has(root) && !isDocLink) continue;
    if (!existsSync(join(repoRoot, target))) {
      note(`${doc} names ${target} in a code span, but that path does not exist`);
    }
  }

  // 4. HQ_JR_* variables the docs name must exist in config.ts. The secret
  // manager examples name entries that are not config keys, so a name is
  // exempt only when the line it appears on is one of those examples.
  for (const m of text.matchAll(/\b(HQ_JR_[A-Z0-9_]+)\b/g)) {
    if (configVars.has(m[1])) continue;
    const line = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index + m[0].length + 200);
    const isSecretManagerExample =
      line.includes("--set-secrets") || line.includes("secret manager");
    if (isSecretManagerExample) continue;
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
if (!structureBlock) {
  note("README has no '## Project Structure' code block, so the tree check cannot run");
} else {
  const stack = [];
  const treePaths = new Set();
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
    treePaths.add(path);
    if (!existsSync(join(repoRoot, path))) {
      note(`README project structure lists ${path}, which does not exist`);
    }
  }

  // Every module under src/ and scripts/ must be named somewhere in the docs,
  // so a new module cannot land undocumented. The README project structure
  // tree counts, and so does a mention by name in any document. A test file is
  // covered by its module.
  const documentText = DOC_FILES.map((doc) => read(doc)).join("\n");
  for (const file of sourceFiles) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.mjs")) continue;
    if (documentText.includes(file)) continue;
    if (treePaths.has(file)) continue;
    note(`${file} is not mentioned in any document`);
  }
}

// 7. A document that says a module is "not wired" into the review path must
// be right. A module that later gets wired has to have that claim removed.
// The claim appears in prose, in a heading, and in a project tree comment, so
// the search is by module name and the claim is looked for near it.
for (const doc of DOC_FILES) {
  const text = read(doc);
  for (const file of sourceFiles) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.mjs")) continue;
    const base = file.split("/").pop();
    // The module can be named by its full path or by its file name alone, as
    // in the README project tree.
    const mentions = new RegExp(
      `\\b(${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`,
      "g"
    );
    for (const m of text.matchAll(mentions)) {
      // The claim must be on the same line as the module name. A claim about a
      // different module further down the page is not about this one.
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      let lineEnd = text.indexOf("\n", m.index);
      if (lineEnd === -1) lineEnd = text.length;
      const line = text.slice(lineStart, lineEnd);
      if (!/\bnot\s+wired\b/i.test(line)) continue;
      // The line must not be naming a different module than the one claimed.
      // Compare whole names, so a line that names both this module and its
      // test file is still a claim about this module.
      const otherModule = sourceFiles.find(
        (f) =>
          f !== file &&
          f.split("/").pop() !== base &&
          new RegExp(`\\b${f.split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
            line
          )
      );
      if (otherModule) continue;
      // A module is wired when a non-test source file imports it. The import
      // path ends in .js because the code is ESM, so match the module name
      // without its extension.
      const moduleName = base.replace(/\.[^.]+$/, "");
      const importedBy = sourceFiles.filter(
        (f) =>
          f !== file &&
          !f.endsWith(".test.ts") &&
          !f.endsWith(".test.mjs") &&
          new RegExp(
            `from\\s+["'][^"']*${moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.js)?["']`
          ).test(read(f))
      );
      if (importedBy.length > 0) {
        note(
          `${doc} says ${file} is not wired, but ${importedBy.join(", ")} imports it`
        );
        break;
      }
    }
  }
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
