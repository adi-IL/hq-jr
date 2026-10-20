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

  it("does not redact environment or member expression references", () => {
    const raw =
      "const secret = process.env.SECRET_KEY;\n" +
      "const client_secret = os.environ['CLIENT_SECRET'];\n" +
      "const apiKey = config.apiKey;";
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toContain("process.env.SECRET_KEY");
    expect(scrubbed).toContain("os.environ['CLIENT_SECRET']");
    expect(scrubbed).toContain("config.apiKey");
    expect(redactedCount).toBe(0);
  });

  it("redacts a credential shaped value that contains a dot", () => {
    const { scrubbed, redactedCount } = scrubSecrets("password: hunter2.abc");

    expect(scrubbed).not.toContain("hunter2.abc");
    expect(scrubbed).toContain("[REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("keeps a quoted bracket access intact", () => {
    const raw = 'password = configuration["secretKey"]';
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("keeps a value that was already redacted intact", () => {
    const raw = "apiKey = sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456789;";
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe("apiKey = [REDACTED_SECRET];");
    expect(redactedCount).toBe(1);
  });

  it("counts a redacted key once", () => {
    const raw = "const apiKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456789';";
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).not.toContain("sk-ant-api03-");
    expect(scrubbed).toContain("[REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("redacts a plain literal secret once", () => {
    const { scrubbed, redactedCount } = scrubSecrets('const password = "hunter2hunter2";');
    expect(scrubbed).toBe('const password = "[REDACTED_SECRET]";');
    expect(redactedCount).toBe(1);
  });

  it("documents the length fragile limitation of the regex scrubber", () => {
    // A fine grained token that is not exactly 82 characters is not redacted.
    // The fake token is assembled at runtime so secret scanners do not flag
    // the fixture itself.
    const shortPat = ["github", "pat", "11A1234567890123456789012345678901234567890"].join("_");
    expect(scrubSecrets(shortPat).scrubbed).toContain(shortPat);
  });

  it("keeps calls and shell interpolation intact", () => {
    const raw = 'password = os.getenv("DB_PASSWORD")\nDB_PASSWORD=${DB_PASSWORD}';
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("redacts a bracket read on a root that is not configuration", () => {
    const { scrubbed, redactedCount } = scrubSecrets('password = hunter2["abc"];');
    expect(scrubbed).toBe("password = [REDACTED_SECRET];");
    expect(redactedCount).toBe(1);
  });

  it("keeps statement punctuation after an unquoted secret", () => {
    const { scrubbed, redactedCount } = scrubSecrets("login(password=abc12345);");
    expect(scrubbed).toBe("login(password=[REDACTED_SECRET]);");
    expect(redactedCount).toBe(1);

    const comma = scrubSecrets("apiKey: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456789,");
    expect(comma.scrubbed).toBe("apiKey: [REDACTED_SECRET],");
    expect(comma.redactedCount).toBe(1);
  });

  it("redacts a quoted secret that contains spaces", () => {
    const { scrubbed, redactedCount } = scrubSecrets('password = "correct horse battery staple"');
    expect(scrubbed).toBe('password = "[REDACTED_SECRET]"');
    expect(redactedCount).toBe(1);
  });

  it("redacts the whole value of a long secret", () => {
    const value = "x".repeat(200);
    const { scrubbed, redactedCount } = scrubSecrets(`password=${value}`);
    expect(scrubbed).toBe("password=[REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("keeps bracket reads with inner spaces or chained keys intact", () => {
    const raw =
      "const secret = credentials[ 'api_key' ];\n" +
      "const apiKey = config['auth']['api_key'];\n" +
      'password = settings.db["primary"].password;';
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("scans a value with unterminated brackets once", () => {
    const raw = `password = ${"[".repeat(60000)}`;
    const started = Date.now();
    const { scrubbed, redactedCount } = scrubSecrets(raw);
    const elapsed = Date.now() - started;

    expect(scrubbed).toBe("password = [REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
    expect(elapsed).toBeLessThan(500);
  });

  it("keeps the semicolon after a key the first pass already redacted", () => {
    const { scrubbed, redactedCount } = scrubSecrets(
      "api_key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456789;"
    );
    expect(scrubbed).toBe("api_key: [REDACTED_SECRET];");
    expect(redactedCount).toBe(1);
  });
});
