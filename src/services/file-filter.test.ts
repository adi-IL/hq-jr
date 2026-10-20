import { describe, it, expect } from "vitest";
import { evaluateFile } from "./file-filter.js";

describe("File Filter & Noise Exclusion", () => {
  it("ignores lockfiles", () => {
    expect(evaluateFile("package-lock.json").shouldIgnore).toBe(true);
    expect(evaluateFile("yarn.lock").shouldIgnore).toBe(true);
    expect(evaluateFile("Cargo.lock").shouldIgnore).toBe(true);
    expect(evaluateFile("pnpm-lock.yaml").shouldIgnore).toBe(true);
  });

  it("ignores binary extensions and generated build directories", () => {
    expect(evaluateFile("assets/logo.png").shouldIgnore).toBe(true);
    expect(evaluateFile("wasm/module.wasm").shouldIgnore).toBe(true);
    expect(evaluateFile("dist/bundle.js").shouldIgnore).toBe(true);
    expect(evaluateFile("node_modules/lodash/index.js").shouldIgnore).toBe(true);
  });

  it("assigns highest priority to security files", () => {
    const authResult = evaluateFile("src/services/auth-tokens.ts");
    expect(authResult.shouldIgnore).toBe(false);
    expect(authResult.category).toBe("SECURITY");
    expect(authResult.riskWeight).toBe(10);
  });

  it("assigns appropriate categories and weights for backend and config files", () => {
    const backendResult = evaluateFile("src/controllers/user.ts");
    expect(backendResult.shouldIgnore).toBe(false);
    expect(backendResult.category).toBe("BACKEND");
    expect(backendResult.riskWeight).toBe(7);

    const configResult = evaluateFile("package.json");
    expect(configResult.shouldIgnore).toBe(false);
    expect(configResult.category).toBe("CONFIG");
    expect(configResult.riskWeight).toBe(5);

    const testResult = evaluateFile("src/controllers/user.test.ts");
    expect(testResult.shouldIgnore).toBe(false);
    expect(testResult.category).toBe("TEST");
    expect(testResult.riskWeight).toBe(3);
  });

  it("ignores TypeScript declaration files", () => {
    const result = evaluateFile("src/types.d.ts");
    expect(result.shouldIgnore).toBe(true);
  });

  it("does not classify files by arbitrary substring matches", () => {
    expect(evaluateFile("src/AuthorProfile.tsx").category).toBe("FRONTEND");
    expect(evaluateFile("src/hooks/useAuthor.ts").category).toBe("BACKEND");
    expect(evaluateFile("src/server/reviewer.ts").category).toBe("BACKEND");
  });

  it("ignores documentation in any docs directory", () => {
    const result = evaluateFile("src/docs/guide.ts");
    expect(result.shouldIgnore).toBe(true);
    expect(result.category).toBe("DOCUMENTATION");
  });
});
