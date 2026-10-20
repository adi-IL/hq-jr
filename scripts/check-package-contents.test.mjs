import { describe, expect, it } from "vitest";
import { filesFromPackReport, forbiddenFiles } from "./check-package-contents.mjs";

describe("forbiddenFiles", () => {
  it.each([
    ".env",
    "config/.env.production",
    ".npmrc",
    "keys/app.pem",
    "private.key",
    "data/hq-jr.db",
    "data/hq-jr.db-wal",
    "gcloud/application_default_credentials.json",
    "credentials",
    ".aws/credentials",
    "service-credentials.json",
    "deploy/credentials.yaml",
    "CREDENTIALS.txt",
  ])("flags %s", (file) => {
    expect(forbiddenFiles([file]).map((entry) => entry.path)).toEqual([file]);
  });

  it.each([
    ".env.example",
    "dist/credentials.js",
    "dist/credentials.d.ts",
    "dist/auth/credentials-store.js",
    "dist/credentials.js.map",
    "README.md",
    "app.yml",
    "package.json",
  ])("allows %s", (file) => {
    expect(forbiddenFiles([file])).toEqual([]);
  });

  it("gives the reason for each match", () => {
    expect(forbiddenFiles(["dist/index.js", "a.pem"])).toEqual([{ path: "a.pem", reason: "key or certificate" }]);
  });
});

describe("filesFromPackReport", () => {
  it("reads the file paths from an npm pack report", () => {
    expect(filesFromPackReport([{ files: [{ path: "dist/index.js" }, { path: "README.md" }] }])).toEqual([
      "dist/index.js",
      "README.md",
    ]);
  });

  it("rejects a report without a file list", () => {
    expect(() => filesFromPackReport([])).toThrow(/no file list/);
    expect(() => filesFromPackReport({})).toThrow(/no file list/);
  });
});
