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

  it("keeps compound security file names at the highest priority", () => {
    const securityFiles = [
      "src/authservice.ts",
      "src/authhandler.go",
      "src/oauth2.ts",
      "src/auth0.ts",
      "src/JWTAuth.ts",
      "src/secretsmanager.ts",
      "src/authenticate.ts",
      "src/services/token-store.ts",
      "src/lib/credential-helper.ts",
      "src/middleware/authorize.ts",
    ];

    for (const file of securityFiles) {
      const result = evaluateFile(file);
      expect(result.category, file).toBe("SECURITY");
      expect(result.riskWeight, file).toBe(10);
      expect(result.shouldIgnore, file).toBe(false);
    }
  });

  it("keeps author and authority style names out of the security category", () => {
    expect(evaluateFile("src/AuthorProfile.tsx").category).toBe("FRONTEND");
    expect(evaluateFile("src/components/AuthorityBadge.tsx").category).toBe("FRONTEND");
    expect(evaluateFile("src/server/reviewer.ts").category).toBe("BACKEND");
    expect(evaluateFile("src/models/author.ts").category).toBe("BACKEND");
  });

  it("ignores documentation in any docs directory", () => {
    const result = evaluateFile("src/docs/guide.ts");
    expect(result.shouldIgnore).toBe(true);
    expect(result.category).toBe("DOCUMENTATION");
  });

  it("reviews security source that sits in a docs directory", () => {
    const session = evaluateFile("src/docs/session-auth.ts");
    expect(session.category).toBe("SECURITY");
    expect(session.shouldIgnore).toBe(false);
    expect(session.riskWeight).toBe(10);

    const token = evaluateFile("packages/docs/token.ts");
    expect(token.category).toBe("SECURITY");
    expect(token.shouldIgnore).toBe(false);
    expect(token.riskWeight).toBe(10);
  });

  it("reviews source files in a docs directory", () => {
    const helper = evaluateFile("src/docs/helper.ts");
    expect(helper.shouldIgnore).toBe(false);
    expect(helper.category).not.toBe("DOCUMENTATION");

    const script = evaluateFile("docs/setup.js");
    expect(script.shouldIgnore).toBe(false);
    expect(script.category).not.toBe("DOCUMENTATION");
  });

  it("finds security roots inside compound words", () => {
    for (const file of [
      "src/errors/UnauthorizedError.ts",
      "src/http/basicauth.go",
      "src/http/apitoken.ts",
      "src/lib/webcrypto.ts",
      "src/aws/clientsecret.ts",
    ]) {
      const result = evaluateFile(file);
      expect(result.category, file).toBe("SECURITY");
      expect(result.riskWeight, file).toBe(10);
    }
  });

  it("keeps look-alike words out of the security category", () => {
    expect(evaluateFile("src/models/coauthor.ts").category).toBe("BACKEND");
    expect(evaluateFile("src/parser/tokenizer.ts").category).toBe("BACKEND");
    expect(evaluateFile("src/hr/secretary.ts").category).toBe("BACKEND");
  });
});
