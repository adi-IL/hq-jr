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
    const started = performance.now();
    const { scrubbed, redactedCount } = scrubSecrets(raw);
    const elapsed = performance.now() - started;

    expect(scrubbed).toBe("password = [REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
    expect(elapsed).toBeLessThan(500);
  });

  it("scans a line of malformed bracket values in linear time", () => {
    const raw = "password = [abcdefgh ".repeat(12000);
    const started = performance.now();
    const { scrubbed, redactedCount } = scrubSecrets(raw);
    const elapsed = performance.now() - started;

    expect(scrubbed).toBe("password = [REDACTED_SECRET] ".repeat(12000));
    expect(redactedCount).toBe(12000);
    expect(elapsed).toBeLessThan(500);
  });

  it("keeps bracket reads of every shape intact", () => {
    const raw =
      'password = configuration["secretKey"];\n' +
      "password = configuration[secretKey];\n" +
      "password = arr[0];\n" +
      "password = config['a']['b'];\n" +
      "password = config[ key ];";
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("redacts a nested bracket read that is not a member expression", () => {
    const { scrubbed, redactedCount } = scrubSecrets("password = config[a[b]]");

    expect(scrubbed).toBe("password = [REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("redacts a malformed bracket value whole", () => {
    const { scrubbed, redactedCount } = scrubSecrets("password=[abcdefgh[i jkl]");

    expect(scrubbed).toBe("password=[REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("redacts a malformed bracket value whole when the space comes first", () => {
    const { scrubbed, redactedCount } = scrubSecrets("password=[abc def[ghi]");

    expect(scrubbed).toBe("password=[REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("redacts a malformed bracket value whole when the value holds a space", () => {
    const { scrubbed, redactedCount } = scrubSecrets("password=[abc def");

    expect(scrubbed).toBe("password=[REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("reads the value as a whole before it is classified", () => {
    // The value is read to its end, so a space inside the bracket does not
    // cut the value in two and the tail of the credential is redacted.
    for (const value of ["[abcdefgh[i jkl]", "[a[b c]", "[abc def[ghi]", "[abc def"]) {
      const { scrubbed, redactedCount } = scrubSecrets(`password=${value}`);

      expect(scrubbed).toBe("password=[REDACTED_SECRET]");
      expect(redactedCount).toBe(1);
    }
  });

  it("keeps a member expression with a spaced key intact", () => {
    const raw = "password = configuration[ secretKey ]";
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("ends a broken bracket value where the next secret assignment starts", () => {
    const { scrubbed, redactedCount } = scrubSecrets(
      "password=[abcdefgh password=realpassword123"
    );

    expect(scrubbed).toBe("password=[REDACTED_SECRET] password=[REDACTED_SECRET]");
    expect(redactedCount).toBe(2);
  });

  it("redacts a malformed bracket value and keeps the punctuation around it", () => {
    const { scrubbed, redactedCount } = scrubSecrets("password=[abcdefgh[i jkl];");

    expect(scrubbed).toBe("password=[REDACTED_SECRET];");
    expect(redactedCount).toBe(1);
  });

  it("redacts a short malformed bracket value whole", () => {
    const { scrubbed, redactedCount } = scrubSecrets("password=[a[b c]");

    expect(scrubbed).toBe("password=[REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("keeps a value that is only an opening bracket", () => {
    const { scrubbed, redactedCount } = scrubSecrets("password = [");

    expect(scrubbed).toBe("password = [");
    expect(redactedCount).toBe(0);
  });

  it("keeps the bracket reads that are code and redacts the ones that are literals", () => {
    const code = ['configuration["secretKey"]', "config[ key ]", "arr[0]", "config['a']['b']"];
    for (const value of code) {
      const { scrubbed, redactedCount } = scrubSecrets(`password=${value}`);

      expect(scrubbed).toBe(`password=${value}`);
      expect(redactedCount).toBe(0);
    }

    const literals = ["[abcdefgh]", "[abcdefgh[i jkl]", "[a[b c]", "abcde1234(secret)"];
    for (const value of literals) {
      const { scrubbed, redactedCount } = scrubSecrets(`password=${value}`);

      expect(scrubbed).toBe("password=[REDACTED_SECRET]");
      expect(redactedCount).toBe(1);
    }
  });

  it("scans a line of malformed bracket values with a nested bracket in linear time", () => {
    const raw = "password=[abcdefgh[i jkl] ".repeat(12000);
    const started = performance.now();
    const { scrubbed, redactedCount } = scrubSecrets(raw);
    const elapsed = performance.now() - started;

    expect(scrubbed).toBe("password=[REDACTED_SECRET] ".repeat(12000));
    expect(redactedCount).toBe(12000);
    expect(elapsed).toBeLessThan(500);
  });

  it("scans a line of malformed bracket values with a space in linear time", () => {
    const raw = "password=[abc def[ghi] ".repeat(12000);
    const started = performance.now();
    const { scrubbed, redactedCount } = scrubSecrets(raw);
    const elapsed = performance.now() - started;

    expect(scrubbed).toBe("password=[REDACTED_SECRET] ".repeat(12000));
    expect(redactedCount).toBe(12000);
    expect(elapsed).toBeLessThan(500);
  });

  it("keeps the semicolon after a key the first pass already redacted", () => {
    const { scrubbed, redactedCount } = scrubSecrets(
      "api_key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456789;"
    );
    expect(scrubbed).toBe("api_key: [REDACTED_SECRET];");
    expect(redactedCount).toBe(1);
  });

  it("redacts a literal value that looks like a call", () => {
    const { scrubbed, redactedCount } = scrubSecrets("password=abcde1234(secret)");

    expect(scrubbed).toBe("password=[REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("redacts a call whose root is not a known accessor", () => {
    const { scrubbed, redactedCount } = scrubSecrets("client_secret = getSecret()");

    expect(scrubbed).toBe("client_secret = [REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("keeps a call on a known accessor intact", () => {
    const raw = 'password = os.getenv("DB_PASSWORD")\npassword = vault.read("secret")';
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("redacts a value that only starts with env", () => {
    for (const value of ["env-abc12345", "env.abc12345", "env/abc12345", "env+abc12345"]) {
      const { scrubbed, redactedCount } = scrubSecrets(`password=${value}`);

      expect(scrubbed).toBe("password=[REDACTED_SECRET]");
      expect(redactedCount).toBe(1);
    }
  });

  it("keeps every environment accessor intact", () => {
    const raw =
      "password = process.env.SECRET_KEY;\n" +
      "password = os.environ['CLIENT_SECRET'];\n" +
      "password = env.SECRET_KEY;\n" +
      "password = this.env.SECRET_KEY;\n" +
      "password = globalThis.env.SECRET_KEY;\n" +
      "password = Deno.env;\n" +
      "password = Bun.env;";
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("keeps a member read with a non-null assertion intact", () => {
    const raw = "api_key = config.apiKey!";
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("keeps a member read with optional chaining intact", () => {
    const raw = "api_key = config?.apiKey";
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("scans a value of closing brackets once", () => {
    const raw = `password = ${"]".repeat(60000)}`;
    const started = performance.now();
    const { scrubbed, redactedCount } = scrubSecrets(raw);
    const elapsed = performance.now() - started;

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });
});
