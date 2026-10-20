import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSameRepository,
  computeNextVersion,
  githubRepositorySlug,
  pickLastLine,
  pickNpmLatest,
  remoteTagExists,
  setLockfileVersion,
  setPackageVersion,
} from "./bump-version.mjs";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "bump-version.mjs");
const repoRoot = path.dirname(path.dirname(scriptPath));

describe("computeNextVersion", () => {
  it("bumps the package.json version when npm is behind or unpublished", () => {
    expect(computeNextVersion("0.1.8", "0.1.7")).toBe("0.1.9");
    expect(computeNextVersion("0.1.8", null)).toBe("0.1.9");
  });

  it("bumps the npm version when npm is ahead", () => {
    expect(computeNextVersion("0.1.8", "0.2.3")).toBe("0.2.4");
  });

  it("rejects versions that are not plain X.Y.Z", () => {
    expect(() => computeNextVersion("0.1.8-beta.1", null)).toThrow(/not a plain X.Y.Z/);
    expect(() => computeNextVersion("0.1.8", "1.0.0-rc.1")).toThrow(/not a plain X.Y.Z/);
  });
});

describe("pickNpmLatest", () => {
  it("returns null for empty output and the highest version otherwise", () => {
    expect(pickNpmLatest("\n")).toBeNull();
    expect(pickNpmLatest("0.1.8\n")).toBe("0.1.8");
    expect(pickNpmLatest("0.1.10\n0.1.9\n")).toBe("0.1.10");
  });
});

describe("pickLastLine", () => {
  it("returns the last value the registry printed", () => {
    expect(pickLastLine("git+https://github.com/adi-IL/hq-jr.git\n")).toBe(
      "git+https://github.com/adi-IL/hq-jr.git"
    );
    expect(pickLastLine("first\nsecond\n")).toBe("second");
  });

  it("strips a matching pair of quotes around the value", () => {
    expect(pickLastLine("'git+https://github.com/adi-IL/hq-jr.git'")).toBe(
      "git+https://github.com/adi-IL/hq-jr.git"
    );
    expect(pickLastLine('"git+https://github.com/adi-IL/hq-jr.git"')).toBe(
      "git+https://github.com/adi-IL/hq-jr.git"
    );
    expect(pickLastLine("`git+https://github.com/adi-IL/hq-jr.git`")).toBe(
      "git+https://github.com/adi-IL/hq-jr.git"
    );
    expect(pickLastLine("' git+https://github.com/adi-IL/hq-jr.git '")).toBe(
      "git+https://github.com/adi-IL/hq-jr.git"
    );
  });

  it("keeps a value whose quotes do not match", () => {
    expect(pickLastLine("'git+https://github.com/adi-IL/hq-jr.git\"")).toBe(
      "'git+https://github.com/adi-IL/hq-jr.git\""
    );
  });

  it("returns null for empty output and the literal undefined", () => {
    expect(pickLastLine("\n")).toBeNull();
    expect(pickLastLine("")).toBeNull();
    expect(pickLastLine("undefined")).toBeNull();
    expect(pickLastLine("'undefined'")).toBeNull();
  });
});

describe("githubRepositorySlug", () => {
  it.each([
    "git+https://github.com/adi-IL/hq-jr.git",
    "https://github.com/adi-IL/hq-jr",
    "https://github.com/adi-IL/hq-jr/",
    "git://github.com/adi-IL/hq-jr.git",
    "git+ssh://git@github.com/adi-IL/hq-jr.git",
    "git@github.com:adi-IL/hq-jr.git",
    "github:adi-IL/hq-jr",
    "adi-IL/hq-jr",
  ])("reads %s as adi-il/hq-jr", (url) => {
    expect(githubRepositorySlug(url)).toBe("adi-il/hq-jr");
  });

  it.each([
    "git+https://github.com/someone/adi-il/hq-jr.git",
    "https://github.com/adi-IL/hq-jr-fork",
    "https://evil.example/adi-IL/hq-jr",
    "https://github.com.evil.example/adi-IL/hq-jr",
    "https://github.com/adi-IL/hq-jr?x=adi-il/hq-jr",
    "",
    undefined,
  ])("does not read %s as adi-il/hq-jr", (url) => {
    expect(githubRepositorySlug(url)).not.toBe("adi-il/hq-jr");
  });
});

describe("assertSameRepository", () => {
  const local = { type: "git", url: "git+https://github.com/adi-IL/hq-jr.git" };

  it("accepts the same repository in another URL form", () => {
    expect(() => assertSameRepository("hq-jr", "https://github.com/adi-il/hq-jr", local)).not.toThrow();
  });

  it("rejects a URL that only contains the slug as a substring", () => {
    expect(() =>
      assertSameRepository("hq-jr", "git+https://github.com/other/adi-il/hq-jr.git", local)
    ).toThrow(/does not own/);
    expect(() => assertSameRepository("hq-jr", "https://github.com/adi-IL/hq-jr-old", local)).toThrow(
      /does not own/
    );
  });

  it("fails closed when the registry has no repository URL", () => {
    expect(() => assertSameRepository("hq-jr", null, local)).toThrow(/has no repository URL/);
  });

  it("fails closed when package.json has no GitHub repository", () => {
    expect(() => assertSameRepository("hq-jr", "https://github.com/adi-IL/hq-jr", undefined)).toThrow(
      /package.json has no GitHub repository URL/
    );
  });
});

describe("remoteTagExists", () => {
  it("maps ls-remote exit 0 to present and exit 2 to absent", () => {
    expect(remoteTagExists(0, "v1.0.0")).toBe(true);
    expect(remoteTagExists(2, "v1.0.0")).toBe(false);
  });

  it("fails on any other exit status", () => {
    expect(() => remoteTagExists(128, "v1.0.0", "fatal: could not read from remote")).toThrow(
      /could not check for tag v1.0.0 on origin \(git exit 128\)/
    );
    expect(() => remoteTagExists(null, "v1.0.0")).toThrow(/git exit unknown/);
  });
});

describe("version writers", () => {
  it("rewrites both lockfile root versions and keeps the format", () => {
    const raw = `${JSON.stringify(
      { name: "hq-jr", version: "0.1.8", lockfileVersion: 3, packages: { "": { name: "hq-jr", version: "0.1.8" } } },
      null,
      2
    )}\n`;
    const out = setLockfileVersion(raw, "hq-jr", "0.1.9");
    const lock = JSON.parse(out);
    expect(lock.version).toBe("0.1.9");
    expect(lock.packages[""].version).toBe("0.1.9");
    expect(out).toBe(raw.replaceAll("0.1.8", "0.1.9"));
  });

  it("refuses a lockfile for another package", () => {
    const raw = JSON.stringify({ name: "other", version: "1.0.0", lockfileVersion: 3, packages: { "": {} } });
    expect(() => setLockfileVersion(raw, "hq-jr", "0.1.9")).toThrow(/is for 'other'/);
  });

  it("keeps CRLF line endings and tab indentation in package.json", () => {
    const raw = '{\r\n\t"name": "hq-jr",\r\n\t"version": "0.1.8"\r\n}\r\n';
    expect(setPackageVersion(raw, "0.1.9")).toBe('{\r\n\t"name": "hq-jr",\r\n\t"version": "0.1.9"\r\n}\r\n');
  });
});

// The fake npm is a POSIX shell script, so this block runs only where /bin/sh exists.
describe.skipIf(process.platform === "win32")("bump-version.mjs end to end", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup({ npmVersion = "0.1.8", npmRepository = "git+https://github.com/adi-IL/hq-jr.git", npmFails = "", origin } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "bump-version-"));
    dirs.push(root);
    const repo = path.join(root, "repo");
    const bin = path.join(root, "bin");
    const bare = path.join(root, "origin.git");
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    mkdirSync(bin);
    copyFileSync(scriptPath, path.join(repo, "scripts", "bump-version.mjs"));

    const gitConfig = path.join(root, "gitconfig");
    writeFileSync(
      gitConfig,
      "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n"
    );
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      FAKE_NPM_VERSION: npmVersion,
      FAKE_NPM_REPOSITORY: npmRepository,
      FAKE_NPM_FAIL: npmFails,
    };
    // A fake npm that answers `npm view <name> version` and `npm view <name> repository.url`.
    writeFileSync(
      path.join(bin, "npm"),
      [
        "#!/bin/sh",
        'if [ "$1" != view ]; then echo "unexpected npm $*" >&2; exit 1; fi',
        'case "$3" in',
        '  version) field=version; value="$FAKE_NPM_VERSION" ;;',
        '  repository.url) field=repository; value="$FAKE_NPM_REPOSITORY" ;;',
        '  *) echo "unexpected npm $*" >&2; exit 1 ;;',
        "esac",
        'if [ "$FAKE_NPM_FAIL" = "$field" ]; then echo "npm error code ETIMEDOUT" >&2; exit 1; fi',
        'if [ "$value" = E404 ]; then echo "npm error code E404" >&2; exit 1; fi',
        'printf "%s\\n" "$value"',
        "",
      ].join("\n")
    );
    chmodSync(path.join(bin, "npm"), 0o755);

    const git = (args, cwd = repo) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
    git(["init", "-q", repo], root);
    writeFileSync(
      path.join(repo, "package.json"),
      `${JSON.stringify(
        { name: "hq-jr", version: "0.1.8", repository: { type: "git", url: "git+https://github.com/adi-IL/hq-jr.git" } },
        null,
        2
      )}\n`
    );
    writeFileSync(
      path.join(repo, "package-lock.json"),
      `${JSON.stringify(
        { name: "hq-jr", version: "0.1.8", lockfileVersion: 3, requires: true, packages: { "": { name: "hq-jr", version: "0.1.8" } } },
        null,
        2
      )}\n`
    );
    git(["add", "."]);
    git(["commit", "-q", "-m", "initial"]);
    if (origin === undefined) {
      git(["init", "-q", "--bare", bare], root);
      git(["remote", "add", "origin", bare]);
    } else {
      git(["remote", "add", "origin", origin]);
    }
    const bump = (...args) =>
      spawnSync(process.execPath, [path.join(repo, "scripts", "bump-version.mjs"), ...args], {
        cwd: repo,
        env,
        encoding: "utf8",
      });
    return { repo, bare, git, bump };
  }

  it("bumps package.json and package-lock.json in one commit and tags it", () => {
    const { repo, git, bump } = setup();
    const result = bump();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version).toBe("0.1.9");
    const lock = JSON.parse(readFileSync(path.join(repo, "package-lock.json"), "utf8"));
    expect(lock.version).toBe("0.1.9");
    expect(lock.packages[""].version).toBe("0.1.9");
    expect(git(["log", "-1", "--format=%s"]).trim()).toBe("chore: release 0.1.9 [skip release]");
    expect(git(["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort()).toEqual([
      "package-lock.json",
      "package.json",
    ]);
    expect(git(["tag", "--list", "v0.1.9"]).trim()).toBe("v0.1.9");
    expect(git(["status", "--porcelain"]).trim()).toBe("");
  });

  it("stops when origin cannot be read instead of assuming the tag is free", () => {
    const { git, bump } = setup({ origin: "/nonexistent/hq-jr-origin.git" });
    const result = bump();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/could not check for tag v0.1.9 on origin \(git exit 128\)/);
    expect(git(["tag", "--list"]).trim()).toBe("");
    expect(git(["log", "-1", "--format=%s"]).trim()).toBe("initial");
  });

  it("stops when the tag already exists on origin", () => {
    const { repo, bare, git, bump } = setup();
    git(["tag", "v0.1.9"]);
    git(["push", "-q", bare, "v0.1.9"]);
    git(["tag", "-d", "v0.1.9"]);
    const result = bump();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/tag v0.1.9 already exists on origin/);
    expect(JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version).toBe("0.1.8");
  });

  it("stops when the npm repository metadata cannot be read", () => {
    const { bump } = setup({ npmFails: "repository" });
    const result = bump();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/could not read the npm repository metadata/);
  });

  it("stops when the npm package belongs to another repository", () => {
    const { bump } = setup({ npmRepository: "git+https://github.com/someone/adi-il/hq-jr.git" });
    const result = bump();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not own/);
  });

  it("accepts a quoted npm repository URL", () => {
    const { git, bump } = setup({ npmRepository: "'git+https://github.com/adi-IL/hq-jr.git'" });
    const result = bump();
    expect(result.status).toBe(0);
    expect(git(["tag", "--list", "v0.1.9"]).trim()).toBe("v0.1.9");
  });

  it("releases an unpublished package without an owner check", () => {
    const { git, bump } = setup({ npmVersion: "E404", npmRepository: "" });
    const result = bump();
    expect(result.status).toBe(0);
    expect(git(["tag", "--list", "v0.1.9"]).trim()).toBe("v0.1.9");
  });

  it("reports the partial state when tagging fails after the commit", () => {
    const { git, bump } = setup();
    // A ref named refs/tags/v0.1.9/x blocks creating refs/tags/v0.1.9 without showing up in `git tag --list v0.1.9`.
    git(["update-ref", "refs/tags/v0.1.9/x", "HEAD"]);
    const result = bump();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/created commit [0-9a-f]+ \(chore: release 0.1.9 \[skip release\]\) but git could not create tag v0.1.9/);
    expect(result.stderr).toMatch(/git reset --keep HEAD~1/);
    expect(git(["log", "-1", "--format=%s"]).trim()).toBe("chore: release 0.1.9 [skip release]");
  });

  it("refuses to bump past a release commit that has no tag", () => {
    const { git, bump } = setup();
    git(["update-ref", "refs/tags/v0.1.9/x", "HEAD"]);
    bump();
    git(["update-ref", "-d", "refs/tags/v0.1.9/x"]);
    const result = bump();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/HEAD is the release commit for 0.1.9, but tag v0.1.9 does not exist/);
    expect(git(["tag", "--list"]).trim()).toBe("");
  });

  it("restores the files when the commit fails", () => {
    const { repo, git, bump } = setup();
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho blocked by hook >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const result = bump();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/git could not commit the release/);
    expect(result.stderr).toMatch(/Nothing was committed or tagged/);
    expect(git(["status", "--porcelain"]).trim()).toBe("");
    expect(JSON.parse(readFileSync(path.join(repo, "package-lock.json"), "utf8")).version).toBe("0.1.8");
  });

  it("rejects a mismatched lockfile on --dry-run too", () => {
    const { repo, git, bump } = setup();
    const lockPath = path.join(repo, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.name = "other";
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    git(["commit", "-q", "-am", "break lockfile"]);
    const result = bump("--dry-run");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/package-lock.json is for 'other'/);
  });

  it("prints the plan and changes nothing on --dry-run", () => {
    const { git, bump } = setup({ npmVersion: "0.2.0" });
    const result = bump("--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/next version:\s+0.2.1/);
    expect(git(["status", "--porcelain"]).trim()).toBe("");
    expect(git(["tag", "--list"]).trim()).toBe("");
  });
});

describe("release workflow", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const publishJob = workflow.slice(
    workflow.indexOf("  publish-npm:"),
    workflow.indexOf("  publish-image:")
  );

  it("downloads the npm artifact outside the git checkout", () => {
    expect(publishJob).toContain("path: ${{ runner.temp }}/npm-package");
    expect(publishJob).toContain(
      "TARBALL: ${{ runner.temp }}/npm-package/${{ needs.verify.outputs.tarball }}"
    );
    expect(publishJob).not.toMatch(/path: npm-package/);
    expect(publishJob).not.toMatch(/TARBALL: npm-package/);
  });

  it("keeps the checkout that the provenance attestation needs", () => {
    expect(publishJob).toContain("uses: actions/checkout@v7");
  });
});
