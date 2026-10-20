import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readConfigDefaults, readEnvBlockDefaultsFrom } from "./check-doc-drift.mjs";

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

  it("skips a command that shares the line with an assignment", () => {
    const parsed = readEnvBlockDefaultsFrom("PORT=8081 npm start\n", ".env.example");
    expect(defaultsOf(parsed).has("PORT")).toBe(false);
    expect(parsed.malformed ?? []).not.toContain("PORT");
  });
});
