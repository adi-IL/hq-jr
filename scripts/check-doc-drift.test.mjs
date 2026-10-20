import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfigDefaults, readEnvBlockDefaultsFrom } from "./check-doc-drift.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "check-doc-drift.mjs");

function defaultsOf(parsed) {
  return parsed.defaults ?? parsed;
}

describe("readConfigDefaults", () => {
  it("reads every default in src/config.ts", () => {
    const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
    const { defaults, unreadable } = readConfigDefaults(source);
    expect(unreadable).toEqual([]);
    expect(defaults.get("PORT")).toBe("3000");
    expect(defaults.get("HQ_JR_AI_TIMEOUT_MS")).toBe("900000");
    expect(defaults.get("HQ_JR_ESCALATION_MIN_RISK")).toBe("HIGH");
    expect(defaults.size).toBe(16);
  });

  it("reads a default that has a trailing comment", () => {
    const { defaults, unreadable } = readConfigDefaults(`
      const envSchema = z.object({
        HQ_JR_WEIRD: z.string().default("weird-value"), // note
      });
    `);
    expect(unreadable).not.toContain("HQ_JR_WEIRD");
    expect(defaults.get("HQ_JR_WEIRD")).toBe("weird-value");
  });

  it("reads a default written on the following line", () => {
    const { defaults, unreadable } = readConfigDefaults(`
      const envSchema = z.object({
        HQ_JR_WEIRD: z.string()
          .default("weird-value"),
      });
    `);
    expect(unreadable).not.toContain("HQ_JR_WEIRD");
    expect(defaults.get("HQ_JR_WEIRD")).toBe("weird-value");
  });

  it("reads a default whose argument is on the following line", () => {
    const { defaults, unreadable } = readConfigDefaults(`
      const envSchema = z.object({
        HQ_JR_WEIRD: z.string().default(
          "weird-value"
        ),
      });
    `);
    expect(unreadable).not.toContain("HQ_JR_WEIRD");
    expect(defaults.get("HQ_JR_WEIRD")).toBe("weird-value");
  });

  it("reports a default expression it cannot read", () => {
    const { defaults, unreadable } = readConfigDefaults(`
      const envSchema = z.object({
        HQ_JR_WEIRD: z.string().default(String(1)),
      });
    `);
    expect(defaults.has("HQ_JR_WEIRD")).toBe(false);
    expect(unreadable).toContain("HQ_JR_WEIRD");
  });

  it("reads a boolean default", () => {
    const { defaults, unreadable } = readConfigDefaults(`
      const envSchema = z.object({
        HQ_JR_WEIRD: z.boolean().default(true),
      });
    `);
    expect(unreadable).not.toContain("HQ_JR_WEIRD");
    expect(defaults.get("HQ_JR_WEIRD")).toBe("true");
  });

  it("decodes an escape sequence in a string default", () => {
    const { defaults, unreadable } = readConfigDefaults(`
      const envSchema = z.object({
        HQ_JR_WEIRD: z.string().default("a\\nb"),
      });
    `);
    expect(unreadable).not.toContain("HQ_JR_WEIRD");
    expect(defaults.get("HQ_JR_WEIRD")).toBe("a\nb");
  });

  it("reports a string default whose escape cannot be decoded", () => {
    const { defaults, unreadable } = readConfigDefaults(`
      const envSchema = z.object({
        HQ_JR_WEIRD: z.string().default("a\\8b"),
      });
    `);
    expect(defaults.has("HQ_JR_WEIRD")).toBe(false);
    expect(unreadable).toContain("HQ_JR_WEIRD");
  });

  it("ignores a commented out default and reads the live one", () => {
    const { defaults, unreadable } = readConfigDefaults(`
      const envSchema = z.object({
        HQ_JR_WEIRD: z.string()
          // .default("stale")
          .default("live"),
      });
    `);
    expect(unreadable).not.toContain("HQ_JR_WEIRD");
    expect(defaults.get("HQ_JR_WEIRD")).toBe("live");
  });

  it("does not read a default that exists only in a comment", () => {
    const { defaults, unreadable } = readConfigDefaults(`
      const envSchema = z.object({
        HQ_JR_WEIRD: z.string(), // .default("stale")
      });
    `);
    expect(defaults.has("HQ_JR_WEIRD")).toBe(false);
    expect(unreadable).not.toContain("HQ_JR_WEIRD");
  });
});

describe("readEnvBlockDefaultsFrom", () => {
  it("reads a CRLF fenced block", () => {
    const parsed = readEnvBlockDefaultsFrom("```bash\r\nPORT=3000\r\n```\r\n", "README.md");
    expect(defaultsOf(parsed).get("PORT")).toBe("3000");
  });

  it("reads an unfenced dotenv file", () => {
    const parsed = readEnvBlockDefaultsFrom("PORT=3000\n", ".env.example");
    expect(defaultsOf(parsed).get("PORT")).toBe("3000");
  });

  it("does not read an assignment outside a fenced block", () => {
    const source = "PORT=8081\n```bash\nNODE_ENV=development\n```\n";
    const parsed = readEnvBlockDefaultsFrom(source, "README.md");
    expect(defaultsOf(parsed).has("PORT")).toBe(false);
    expect(defaultsOf(parsed).get("NODE_ENV")).toBe("development");
  });

  it("strips a trailing comment and keeps the value", () => {
    const parsed = readEnvBlockDefaultsFrom("PORT=9999 # drifted\n", ".env.example");
    expect(defaultsOf(parsed).get("PORT")).toBe("9999");
  });

  it("records an empty assignment", () => {
    const parsed = readEnvBlockDefaultsFrom("PORT=\n", ".env.example");
    expect(defaultsOf(parsed).get("PORT")).toBe("");
  });

  it("strips matching quotes", () => {
    const parsed = readEnvBlockDefaultsFrom('PORT="3000"\n', ".env.example");
    expect(defaultsOf(parsed).get("PORT")).toBe("3000");
    expect(parsed.malformed ?? []).not.toContain("PORT");
  });

  it("reports an unmatched quote even when the leftover text matches the default", () => {
    const parsed = readEnvBlockDefaultsFrom('PORT="3000\n', ".env.example");
    expect(parsed.malformed).toContain("PORT");
  });

  it("reports an unmatched quote when the value changed", () => {
    const parsed = readEnvBlockDefaultsFrom('PORT="9999\n', ".env.example");
    expect(parsed.malformed).toContain("PORT");
  });

  it("reports a fenced document whose blocks could not be read", () => {
    const parsed = readEnvBlockDefaultsFrom("``` not a block\nPORT=1\n", "README.md");
    expect(parsed.blocksUnreadable).toBe(true);
    expect(parsed.defaults.has("PORT")).toBe(false);
  });

  it("reports an unmatched fence that follows a closed block", () => {
    const parsed = readEnvBlockDefaultsFrom(
      "```bash\nPORT=3000\n```\n```bash\nNODE_ENV=production\n",
      "README.md"
    );
    expect(parsed.blocksUnreadable).toBe(true);
  });

  it("skips a command that shares the line with an assignment", () => {
    const parsed = readEnvBlockDefaultsFrom("PORT=8081 npm start\n", ".env.example");
    expect(defaultsOf(parsed).has("PORT")).toBe(false);
    expect(parsed.malformed ?? []).not.toContain("PORT");
  });
});

describe("the drift check on a copy of the tree", () => {
  /**
   * Runs the check against a copy of the tree, so a test can change a file
   * without changing the repository. The copy holds the tree the check reads.
   */
  function runCheck(change) {
    const root = mkdtempSync(join(tmpdir(), "doc-drift-"));
    try {
      for (const entry of ["src", "docs", "README.md", ".env.example"]) {
        cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
      }
      change(root);
      try {
        const output = execFileSync("node", [script, `--tree=${root}`], {
          cwd: root,
          encoding: "utf8",
        });
        return { output, code: 0 };
      } catch (error) {
        const err = error;
        return { output: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("passes on the tree as it is", () => {
    const { code } = runCheck(() => {});
    expect(code).toBe(0);
  });

  it("reports a variable that .env.example names and config.ts does not define", () => {
    const { output, code } = runCheck((root) => {
      const file = join(root, ".env.example");
      writeFileSync(file, `${readFileSync(file, "utf8")}HQ_JR_NOT_A_REAL_VAR=1\n`);
    });
    expect(code).toBe(1);
    expect(output).toContain("HQ_JR_NOT_A_REAL_VAR");
  });

  it("reports a variable that the README names and config.ts does not define", () => {
    const { output, code } = runCheck((root) => {
      const file = join(root, "README.md");
      const source = readFileSync(file, "utf8");
      const anchor = "HQ_JR_MODEL_TIER1=gemini-3.8-flash";
      expect(source).toContain(anchor);
      writeFileSync(file, source.replace(anchor, `${anchor}\nHQ_JR_NOT_A_REAL_VAR=1`));
    });
    expect(code).toBe(1);
    expect(output).toContain("HQ_JR_NOT_A_REAL_VAR");
  });

  it("reports a variable that config.ts defines and the docs do not name", () => {
    const { output, code } = runCheck((root) => {
      const file = join(root, "src", "config.ts");
      const source = readFileSync(file, "utf8");
      const anchor = "  HQ_JR_MODEL_TIER1:";
      expect(source).toContain(anchor);
      writeFileSync(
        file,
        source.replace(
          anchor,
          '  HQ_JR_NOT_A_REAL_VAR: z.string().default("x"),\n' + anchor
        )
      );
    });
    expect(code).toBe(1);
    expect(output).toContain("HQ_JR_NOT_A_REAL_VAR");
  });
});
