import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const script = join(repoRoot, "scripts", "check-doc-code-sanity.mjs");
const readmePath = join(repoRoot, "README.md");

/**
 * Runs the sanity check against a README and returns its output and exit code.
 * The README is restored afterwards, whatever happens.
 */
function runCheck(readme) {
  const original = readFileSync(readmePath, "utf8");
  writeFileSync(readmePath, readme);
  try {
    const output = execFileSync("node", [script], { cwd: repoRoot, encoding: "utf8" });
    return { output, code: 0 };
  } catch (error) {
    const err = error;
    // The script reports problems on stderr and exits with 1.
    return { output: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  } finally {
    writeFileSync(readmePath, original);
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
});
