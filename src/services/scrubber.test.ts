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

  it("redacts the assignment that follows a quoted password banner", () => {
    const { scrubbed, redactedCount } = scrubSecrets(
      'const banner = "password = "; const password = "realsecretvalue"'
    );

    expect(scrubbed).toBe('const banner = "password = "; const password = "[REDACTED_SECRET]"');
    expect(redactedCount).toBe(1);
  });

  it("redacts a secret passed inside a call", () => {
    const getenv = scrubSecrets('client_secret = os.getenv("super-secret-value")');
    expect(getenv.scrubbed).toBe("client_secret = [REDACTED_SECRET]");
    expect(getenv.redactedCount).toBe(1);

    const hash = scrubSecrets('password = hash("supersecretvalue")');
    expect(hash.scrubbed).toBe("password = [REDACTED_SECRET]");
    expect(hash.redactedCount).toBe(1);
  });

  it("redacts the indented lines of a yaml block scalar", () => {
    const { scrubbed, redactedCount } = scrubSecrets("api_key: |\n  supersecretvalue");

    expect(scrubbed).not.toContain("supersecretvalue");
    expect(redactedCount).toBe(1);
  });

  it("redacts a token segment on every reference root", () => {
    for (const value of ["config.abc12345", "settings.abc12345", "config.s3cr3tvalue", "env.abc12345"]) {
      const { scrubbed, redactedCount } = scrubSecrets(`password = ${value}`);

      expect(scrubbed, value).toBe("password = [REDACTED_SECRET]");
      expect(redactedCount, value).toBe(1);
    }
  });

  it("keeps legitimate configuration references", () => {
    const raw = [
      "password = config.apiKey",
      "password = settings.maxRetries",
      "password = process.env.SECRET_KEY",
      "password = os.environ.CLIENT_SECRET",
      "password = config.timeoutMs",
      "password = cfg.baseUrl",
      'password = os.getenv("DB_PASSWORD")',
    ].join("\n");
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("keeps a long bracket read whose root is an identifier", () => {
    const raw = [
      "password = users[currentId]",
      "password = items[100]",
      "password = arr[0]",
      "password = config[ key ]",
      'password = configuration["secretKey"]',
    ].join("\n");
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(raw);
    expect(redactedCount).toBe(0);
  });

  it("redacts a bracket whose contents are a token", () => {
    const { scrubbed, redactedCount } = scrubSecrets("password = users[abc12345]");

    expect(scrubbed).toBe("password = [REDACTED_SECRET]");
    expect(redactedCount).toBe(1);
  });

  it("redacts the whole value of keys that previously leaked", () => {
    const hex = "ab".repeat(32);
    const secretKey = scrubSecrets(`secret_key = "${hex}"`);
    expect(secretKey.scrubbed).toBe('secret_key = "[REDACTED_SECRET]"');
    expect(secretKey.redactedCount).toBe(1);

    const apiKey = "ab".repeat(16);
    const api = scrubSecrets(`api-key: ${apiKey}`);
    expect(api.scrubbed).toBe("api-key: [REDACTED_SECRET]");
    expect(api.redactedCount).toBe(1);

    const privateKey = scrubSecrets('private_key: "not-a-pem-value"');
    expect(privateKey.scrubbed).toBe('private_key: "[REDACTED_SECRET]"');
    expect(privateKey.redactedCount).toBe(1);

    const database = scrubSecrets(
      "DATABASE_URL=postgres://app:supersecretvalue@db.internal:5432/app"
    );
    expect(database.scrubbed).toBe("DATABASE_URL=[REDACTED_SECRET]");
    expect(database.redactedCount).toBe(1);

    const token = scrubSecrets('token = "supersecretvalue12345"');
    expect(token.scrubbed).toBe('token = "[REDACTED_SECRET]"');
    expect(token.redactedCount).toBe(1);

    const apiToken = scrubSecrets('api-token: "supersecretvalue12345"');
    expect(apiToken.scrubbed).toBe('api-token: "[REDACTED_SECRET]"');
    expect(apiToken.redactedCount).toBe(1);
  });

  it("redacts a short secret_key value", () => {
    const { scrubbed, redactedCount } = scrubSecrets('secret_key = "abc"');

    expect(scrubbed).toBe('secret_key = "[REDACTED_SECRET]"');
    expect(redactedCount).toBe(1);
  });

  it("redacts a secret assignment inside a quoted string", () => {
    const raw = scrubSecrets('const payload = "{"password":"supersecret"}"');
    expect(raw.scrubbed).toBe('const payload = "{"password":"[REDACTED_SECRET]"}"');
    expect(raw.redactedCount).toBe(1);

    const wrapped = scrubSecrets('const payload = \'{"password":"supersecret"}\'');
    expect(wrapped.scrubbed).toBe('const payload = \'{"password":"[REDACTED_SECRET]"}\'');
    expect(wrapped.redactedCount).toBe(1);

    const escaped = scrubSecrets('const payload = "{\\"password\\":\\"supersecret\\"}"');
    expect(escaped.scrubbed).toBe('const payload = "{\\"password\\":\\"[REDACTED_SECRET]\\"}"');
    expect(escaped.redactedCount).toBe(1);

    const plain = scrubSecrets('const label = "hello world"');
    expect(plain.scrubbed).toBe('const label = "hello world"');
    expect(plain.redactedCount).toBe(0);
  });

  it("finds a key that follows an unpaired quote in a comment", () => {
    const sameLine = scrubSecrets('// it\'s a comment password = "realsecretvalue" trailing');
    expect(sameLine.scrubbed).toBe('// it\'s a comment password = "[REDACTED_SECRET]" trailing');
    expect(sameLine.redactedCount).toBe(1);

    const nextLine = scrubSecrets('// it\'s a comment with a quote\npassword = "realsecretvalue"');
    expect(nextLine.scrubbed).toBe('// it\'s a comment with a quote\npassword = "[REDACTED_SECRET]"');
    expect(nextLine.redactedCount).toBe(1);

    const prose = scrubSecrets('note it\'s fine password = "realsecretvalue" done');
    expect(prose.scrubbed).toBe('note it\'s fine password = "[REDACTED_SECRET]" done');
    expect(prose.redactedCount).toBe(1);
  });

  it("matches a secret key after an underscore", () => {
    const { scrubbed, redactedCount } = scrubSecrets("DB_PASSWORD=hunter2hunter2");
    expect(scrubbed).toBe("DB_PASSWORD=[REDACTED_SECRET]");
    expect(redactedCount).toBe(1);

    const separators = ["-", ".", "/", "$", " ", "(", "@", "#", "+", "*", ",", ";", ":", "=", "[", "{", "!", "?", "%", "&", "~", "^", "\\", "|", "<", ">"];
    for (const separator of separators) {
      const result = scrubSecrets(`${separator}PASSWORD=hunter2hunter2`);
      expect(result.scrubbed, separator).toBe(`${separator}PASSWORD=[REDACTED_SECRET]`);
      expect(result.redactedCount, separator).toBe(1);
    }

    const glued = scrubSecrets("xPASSWORD=hunter2hunter2");
    expect(glued.scrubbed).toBe("xPASSWORD=hunter2hunter2");
    expect(glued.redactedCount).toBe(0);

    const trailing = scrubSecrets("PASSWORD_DB=hunter2hunter2");
    expect(trailing.scrubbed).toBe("PASSWORD_DB=hunter2hunter2");
    expect(trailing.redactedCount).toBe(0);
  });

  it("keeps the line break after a block scalar", () => {
    const { scrubbed, redactedCount } = scrubSecrets("api_key: |\n  supersecretvalue\nnext_key: value");
    expect(scrubbed).toBe("api_key: [REDACTED_SECRET]\nnext_key: value");
    expect(redactedCount).toBe(1);

    const following = scrubSecrets("api_key: |\n  supersecretvalue\ntoken: othersecretvalue");
    expect(following.scrubbed).toBe("api_key: [REDACTED_SECRET]\ntoken: [REDACTED_SECRET]");
    expect(following.redactedCount).toBe(2);
  });

  it("keeps a semicolon or comma inside one secret value", () => {
    const password = scrubSecrets("password = abc;defg");
    expect(password.scrubbed).toBe("password = [REDACTED_SECRET]");
    expect(password.redactedCount).toBe(1);

    const comma = scrubSecrets("password = abc,defg");
    expect(comma.scrubbed).toBe("password = [REDACTED_SECRET]");
    expect(comma.redactedCount).toBe(1);

    const shortKey = scrubSecrets("secret_key = abc;def");
    expect(shortKey.scrubbed).toBe("secret_key = [REDACTED_SECRET]");
    expect(shortKey.redactedCount).toBe(1);

    const split = scrubSecrets("password = abc;defg; token = othersecretvalue");
    expect(split.scrubbed).toBe("password = [REDACTED_SECRET]; token = [REDACTED_SECRET]");
    expect(split.redactedCount).toBe(2);

    const call = scrubSecrets("login(password=abc12345);");
    expect(call.scrubbed).toBe("login(password=[REDACTED_SECRET]);");
    expect(call.redactedCount).toBe(1);
  });

  it("does not treat the next key as an empty block scalar", () => {
    const empty = scrubSecrets("password: |\nother: value");
    expect(empty.scrubbed).toBe("password: |\nother: value");
    expect(empty.redactedCount).toBe(0);

    const sibling = scrubSecrets("password: |\ntoken: supersecretvalue");
    expect(sibling.scrubbed).toBe("password: |\ntoken: [REDACTED_SECRET]");
    expect(sibling.redactedCount).toBe(1);
  });

  it("keeps ordinary code and configuration references unredacted", () => {
    const raw = [
      'const label = "hello world"',
      'const note = "password"',
      "const banner = \"password = \"; const password = \"realsecretvalue\"",
      "password = process.env.SECRET_KEY",
      'password = os.getenv("DB_PASSWORD")',
      "password = config.apiKey",
      "password = users[currentId]",
      "password = arr[0]",
      "DB_PASSWORD=${DB_PASSWORD}",
      "function checkPassword() { return 1; }",
    ].join("\n");
    const { scrubbed, redactedCount } = scrubSecrets(raw);

    expect(scrubbed).toBe(
      [
        'const label = "hello world"',
        'const note = "password"',
        "const banner = \"password = \"; const password = \"[REDACTED_SECRET]\"",
        "password = process.env.SECRET_KEY",
        'password = os.getenv("DB_PASSWORD")',
        "password = config.apiKey",
        "password = users[currentId]",
        "password = arr[0]",
        "DB_PASSWORD=${DB_PASSWORD}",
        "function checkPassword() { return 1; }",
      ].join("\n")
    );
    expect(redactedCount).toBe(1);
  });
});

describe("scrubber assignment operators", () => {
  it("leaves a comparison alone", () => {
    const strict = scrubSecrets("if (password === confirmPassword) { check(); }");
    expect(strict.scrubbed).toBe("if (password === confirmPassword) { check(); }");
    expect(strict.redactedCount).toBe(0);

    const loose = scrubSecrets("if (token == validToken) { check(); }");
    expect(loose.scrubbed).toBe("if (token == validToken) { check(); }");
    expect(loose.redactedCount).toBe(0);
  });

  it("leaves an arrow function alone", () => {
    const arrow = scrubSecrets("const f = token => process(token);");
    expect(arrow.scrubbed).toBe("const f = token => process(token);");
    expect(arrow.redactedCount).toBe(0);
  });

  it("redacts the value of a Go short declaration", () => {
    const go = scrubSecrets('password := "secretvalue"');
    expect(go.scrubbed).not.toContain("secretvalue");
    expect(go.redactedCount).toBe(1);
  });

  it("still redacts a real assignment", () => {
    const plain = scrubSecrets('password = "hunter2hunter2"');
    expect(plain.scrubbed).toBe('password = "[REDACTED_SECRET]"');
    expect(plain.redactedCount).toBe(1);

    const env = scrubSecrets("DB_PASSWORD=hunter2hunter2");
    expect(env.scrubbed).toBe("DB_PASSWORD=[REDACTED_SECRET]");
    expect(env.redactedCount).toBe(1);
  });

  it("does not count an already redacted placeholder", () => {
    const already = scrubSecrets("apiKey = [REDACTED_SECRET]");
    expect(already.redactedCount).toBe(0);
    expect(already.scrubbed).toBe("apiKey = [REDACTED_SECRET]");
  });
});
