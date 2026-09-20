import { describe, it, expect } from "vitest";
import { scrubSecrets } from "./scrubber.js";

describe("Secret Scrubber", () => {
  it("redacts GitHub personal access tokens", () => {
    const raw = "const token = 'ghp_1111222233334444555566667777888899990000';";
    const { scrubbed, redactedCount } = scrubSecrets(raw);
    expect(scrubbed).not.toContain("ghp_1111222233334444555566667777888899990000");
    expect(scrubbed).toContain("[REDACTED_SECRET]");
    expect(redactedCount).toBeGreaterThanOrEqual(1);
  });

  it("redacts AWS access keys and secrets", () => {
    const raw = 'const accessKey = "AKIAIOSFODNN7EXAMPLE";\naws_secret_access_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";';
    const { scrubbed, redactedCount } = scrubSecrets(raw);
    expect(scrubbed).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(scrubbed).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(redactedCount).toBeGreaterThanOrEqual(2);
  });

  it("redacts RSA private keys", () => {
    const raw = `
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1+examplePrivateDataKey1234567890abcdefghijklmnopqrstuvwxyz
-----END RSA PRIVATE KEY-----
`;
    const { scrubbed, redactedCount } = scrubSecrets(raw);
    expect(scrubbed).not.toContain("examplePrivateDataKey1234567890");
    expect(scrubbed).toContain("[REDACTED_SECRET]");
    expect(redactedCount).toBeGreaterThanOrEqual(1);
  });

  it("redacts API keys and passwords in variable assignments", () => {
    const raw = 'const apiKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456789";';
    const { scrubbed, redactedCount } = scrubSecrets(raw);
    expect(scrubbed).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456789");
    expect(scrubbed).toContain("[REDACTED_SECRET]");
    expect(redactedCount).toBeGreaterThanOrEqual(1);
  });
});
