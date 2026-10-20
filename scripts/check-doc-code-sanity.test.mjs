import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "check-doc-code-sanity.mjs");
const readmePath = join(repoRoot, "README.md");

/**
 * Runs the sanity check against a README and returns its output and exit code.
 * The README is written to a copy inside the repository and the tracked file
 * is never touched, so an interrupted run cannot leave the repository
 * modified. The copy is removed whatever happens.
 */
function runCheck(readme, overrides = {}) {
  const dir = mkdtempSync(join(repoRoot, ".doc-sanity-"));
  const readmeCopy = join(dir, "README.md");
  const args = [];
  try {
    writeFileSync(readmeCopy, readme);
    args.push(`README.md=${readmeCopy}`);
    for (const [doc, text] of Object.entries(overrides)) {
      const copy = join(dir, doc.replace(/[\\/]/g, "_"));
      writeFileSync(copy, text);
      args.push(`${doc}=${copy}`);
    }
    try {
      const output = execFileSync("node", [script, ...args], { cwd: repoRoot, encoding: "utf8" });
      return { output, code: 0 };
    } catch (error) {
      const err = error;
      // The script reports problems on stderr and exits with 1.
      return { output: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The README with the given line ending. Every tree entry keeps its trailing
 * comment, which is how the shipped README looks.
 */
function readmeWith(crlf) {
  const original = readFileSync(readmePath, "utf8");
  const eol = crlf ? "\r\n" : "\n";
  return original.split(/\r?\n/).join(eol);
}

describe("check-doc-code-sanity project structure parsing", () => {
  it("passes on the shipped README", () => {
    const { code } = runCheck(readFileSync(readmePath, "utf8"));
    expect(code).toBe(0);
  });

  it("reads the tree entries when the README uses CRLF line endings", () => {
    const readme = readmeWith(true);
    expect(readme).toContain("\r\n");

    // The tree entries must still be read. When they are not, every module
    // under src/ and scripts/ looks undocumented and the check fails.
    const { output, code } = runCheck(readme);
    expect(code).toBe(0);
    expect(output).not.toContain("is not mentioned in any document");
  });

  it("reads the tree entries when the README uses LF line endings", () => {
    const readme = readmeWith(false);
    expect(readme).not.toContain("\r\n");

    const { output, code } = runCheck(readme);
    expect(code).toBe(0);
    expect(output).not.toContain("is not mentioned in any document");
  });

  it("still reports a tree entry that does not exist on disk", () => {
    const readme = readmeWith(true).replace(/cli\.ts(\s+)#/, "cli-does-not-exist.ts$1#");
    expect(readme).toContain("cli-does-not-exist.ts");

    const { output, code } = runCheck(readme);
    expect(code).toBe(1);
    expect(output).toContain("README project structure lists");
  });

  it("fails when the project structure block is missing", () => {
    const readme = readFileSync(readmePath, "utf8").replace(
      /## Project Structure[\s\S]*?```[\s\S]*?```/,
      "## Project Structure\n\nThe tree was removed."
    );
    const { output, code } = runCheck(readme);
    expect(code).toBe(1);
    expect(output).toContain("no '## Project Structure' code block");
  });

  it("reports a new module whose filename already appears in the README", () => {
    const extra = join(repoRoot, "src/services/index.ts");
    writeFileSync(extra, "export const extra = 1;\n");
    try {
      const { output, code } = runCheck(readFileSync(readmePath, "utf8"));
      expect(code).toBe(1);
      expect(output).toContain("src/services/index.ts is not mentioned");
    } finally {
      unlinkSync(extra);
    }
  });

  it("reports a code span under a directory that does not exist", () => {
    const readme = readFileSync(readmePath, "utf8").replace(
      "## Project Structure",
      "`src/removed-directory/gone.ts`\n\n## Project Structure"
    );
    const { output, code } = runCheck(readme);
    expect(code).toBe(1);
    expect(output).toContain("src/removed-directory/gone.ts");
  });

  it("reports a code span for a file removed from a real directory", () => {
    const readme = readFileSync(readmePath, "utf8").replace(
      "## Project Structure",
      "`src/services/gone.ts`\n\n## Project Structure"
    );
    const { output, code } = runCheck(readme);
    expect(code).toBe(1);
    expect(output).toContain("src/services/gone.ts");
  });

  it("does not require a test file to be named in the docs", () => {
    const extra = join(repoRoot, "src/services/zz-doc-only.test.ts");
    writeFileSync(extra, "export const t = 1;\n");
    try {
      const { output, code } = runCheck(readFileSync(readmePath, "utf8"));
      expect(output).not.toContain("zz-doc-only.test.ts");
      expect(code).toBe(0);
    } finally {
      unlinkSync(extra);
    }
  });
});

describe("unknown HQ_JR names", () => {
  const docs05 = join(repoRoot, "docs/05-deployment-and-operations.md");

  function withDocs05(next) {
    return runCheck(readFileSync(readmePath, "utf8"), {
      "docs/05-deployment-and-operations.md": next,
    });
  }

  it("reports an unknown variable on the line above a --set-secrets example", () => {
    const original = readFileSync(docs05, "utf8");
    const { output, code } = withDocs05(
      original.replace("  --set-secrets", "  HQ_JR_TYPO_NEAR=1\n  --set-secrets")
    );
    expect(code).toBe(1);
    expect(output).toContain("HQ_JR_TYPO_NEAR");
  });

  it("reports an unknown variable on the same line as --set-secrets", () => {
    const original = readFileSync(docs05, "utf8");
    const { output, code } = withDocs05(original.replace("--set-secrets", "--set-secrets HQ_JR_TYPO_SAME"));
    expect(code).toBe(1);
    expect(output).toContain("HQ_JR_TYPO_SAME");
  });

  it("still allows the external secret names on the --set-secrets line", () => {
    const { code, output } = runCheck(readFileSync(readmePath, "utf8"));
    expect(code).toBe(0);
    expect(output).not.toContain("HQ_JR_APP_ID");
  });
});

describe("not wired claims", () => {
  const wire = join(repoRoot, "src/services/zz-wire.ts");

  function withWire(source) {
    writeFileSync(wire, source);
    try {
      return runCheck(readFileSync(readmePath, "utf8"));
    } finally {
      unlinkSync(wire);
    }
  }

  it("fails when a bare specifier imports a module the docs call not wired", () => {
    const { output, code } = withWire('import { cache } from "symbol-cache.js";\nexport const cache = 1;\n');
    expect(code).toBe(1);
    expect(output).toContain("not wired");
    expect(output).toContain("zz-wire.ts");
  });

  it("fails when a dynamic import wires a module the docs call not wired", () => {
    const { output, code } = withWire(
      'export const loaded = import("./symbol-cache.js");\n'
    );
    expect(code).toBe(1);
    expect(output).toContain("not wired");
  });

  it("does not treat an import of symbol-cache-utils as an import of symbol-cache", () => {
    const { output } = withWire(
      'import { cache } from "./symbol-cache-utils.js";\nexport const cache = 1;\n'
    );
    expect(output).not.toContain("not wired");
  });
});
