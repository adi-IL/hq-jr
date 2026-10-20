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
    ".netrc",
    "id_rsa",
    "keys/id_ed25519",
    "keys/AuthKey_ABC123.p8",
    "release.jks",
    "legacy_credentials/me@example.com/adc.json",
    "gcloud/configurations/config_default",
    "my-project-service-account.json",
    "service_account_key.json",
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
    "dist/services/account.js",
    "dist/id_rsa.js",
  ])("allows %s", (file) => {
    expect(forbiddenFiles([file])).toEqual([]);
  });

  it("normalizes Windows path separators", () => {
    expect(forbiddenFiles(["gcloud\\application_default_credentials.json", "dist\\index.js"])).toEqual([
      { path: "gcloud\\application_default_credentials.json", reason: "Google ADC file" },
    ]);
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

  it("rejects a report with an empty file list", () => {
    expect(() => filesFromPackReport([{ files: [] }])).toThrow(/lists no files/);
  });
});
