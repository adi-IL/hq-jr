import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertReleaseVersion,
  assertSameRepository,
  computeNextVersion,
  githubRepositorySlug,
  parseReleaseTag,
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

describe("parseReleaseTag", () => {
  it("reads the version a release tag names", () => {
    expect(parseReleaseTag("v0.1.9")).toBe("0.1.9");
    expect(parseReleaseTag(" v1.2.3 ")).toBe("1.2.3");
  });

  it("rejects tags that are not a plain release version", () => {
    expect(parseReleaseTag("v0.1")).toBeNull();
    expect(parseReleaseTag("v0.1.9-rc.1")).toBeNull();
    expect(parseReleaseTag("0.1.9")).toBeNull();
    expect(parseReleaseTag("release")).toBeNull();
    expect(parseReleaseTag(undefined)).toBeNull();
  });
});

describe("assertReleaseVersion", () => {
  it("returns the version when the tag names the package version", () => {
    expect(assertReleaseVersion("v0.1.9", "0.1.9")).toBe("0.1.9");
  });

  it("fails when the tag does not name the package version", () => {
    expect(() => assertReleaseVersion("v0.1.9", "0.1.8")).toThrow(
      /does not match the package.json version '0.1.8'/
    );
  });

  it("fails when the tag is not a release tag", () => {
    expect(() => assertReleaseVersion("v0.1", "0.1.9")).toThrow(/is not a vMAJOR.MINOR.PATCH tag/);
  });
});

describe("pickNpmLatest", () => {
  it("returns null for empty output and the highest version otherwise", () => {
    expect(pickNpmLatest("\n")).toBeNull();
    expect(pickNpmLatest("0.1.8\n")).toBe("0.1.8");
    expect(pickNpmLatest("0.1.10\n0.1.9\n")).toBe("0.1.10");
  });

  it("reads a version the registry printed inside quotes", () => {
    expect(pickNpmLatest("'0.1.9'\n")).toBe("0.1.9");
    expect(pickNpmLatest('"0.1.9"\n')).toBe("0.1.9");
    expect(pickNpmLatest("`0.1.9`\n")).toBe("0.1.9");
  });

  it("reads a quoted value the same way the repository reader does", () => {
    for (const quoted of ["'0.1.9'", '"0.1.9"', "`0.1.9`"]) {
      expect(pickNpmLatest(`${quoted}\n`)).toBe(pickLastLine(`${quoted}\n`));
    }
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

  it("checks the release tag against the package version", () => {
    const { bump } = setup();
    const matching = bump("--check-release-version", "v0.1.9", "0.1.9");
    expect(matching.status).toBe(0);
    expect(matching.stdout.trim()).toBe("0.1.9");

    const mismatched = bump("--check-release-version", "v0.1.9", "0.1.8");
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toMatch(/does not match the package.json version '0.1.8'/);

    const notAReleaseTag = bump("--check-release-version", "v0.1", "0.1.9");
    expect(notAReleaseTag.status).toBe(1);
    expect(notAReleaseTag.stderr).toMatch(/is not a vMAJOR.MINOR.PATCH tag/);
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
  const prepareJob = workflow.slice(workflow.indexOf("  prepare:"), workflow.indexOf("  verify:"));
  const laterJobs = workflow.slice(workflow.indexOf("  verify:"));
  const publishJob = workflow.slice(
    workflow.indexOf("  publish-npm:"),
    workflow.indexOf("  publish-image:")
  );
  const imageJob = workflow.slice(
    workflow.indexOf("  publish-image:"),
    workflow.indexOf("  create-release:")
  );
  const releaseJob = workflow.slice(workflow.indexOf("  create-release:"));
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The shell script of one named step, taken from a job in the workflow file. */
  function stepScript(job, stepName) {
    const step = job.slice(job.indexOf(`- name: ${stepName}`));
    const lines = step.slice(step.indexOf("        run: |")).split("\n").slice(1);
    const script = [];
    for (const line of lines) {
      if (line.trim() && !line.startsWith("          ")) break;
      script.push(line.slice(10));
    }
    return script.join("\n");
  }

  /** The shell script of the publish step, taken from the workflow file. */
  function publishScript() {
    return stepScript(publishJob, "Publish to npm");
  }

  /** Runs the publish step against a fake npm and reports what it published. */
  function runPublishStep({ published, latest }) {
    const root = mkdtempSync(path.join(tmpdir(), "release-publish-"));
    dirs.push(root);
    const bin = path.join(root, "bin");
    const runnerTemp = path.join(root, "runner");
    const log = path.join(root, "published.log");
    mkdirSync(bin);
    mkdirSync(runnerTemp);
    writeFileSync(log, "");
    writeFileSync(
      path.join(bin, "npm"),
      [
        "#!/bin/sh",
        `if [ "$1" = publish ]; then echo "$@" >> "${log}"; exit 0; fi`,
        'if [ "$1" != view ]; then echo "unexpected npm $*" >&2; exit 1; fi',
        'case "$3" in',
        "  version)",
        '    if [ "$2" != "$NAME@$VERSION" ]; then echo "unexpected npm $*" >&2; exit 1; fi',
        '    if [ -n "$PUBLISHED" ]; then printf "%s\\n" "$PUBLISHED"; else echo "npm error code E404" >&2; exit 1; fi',
        "    ;;",
        "  dist-tags.latest)",
        '    if [ "$2" != "$NAME" ]; then echo "unexpected npm $*" >&2; exit 1; fi',
        '    printf "%s\\n" "$LATEST"',
        "    ;;",
        '  *) echo "unexpected npm $*" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n")
    );
    chmodSync(path.join(bin, "npm"), 0o755);
    const script = path.join(root, "publish.sh");
    writeFileSync(script, publishScript());
    const result = spawnSync("bash", ["-e", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        NAME: "hq-jr",
        VERSION: "0.1.9",
        TARBALL: path.join(root, "hq-jr-0.1.9.tgz"),
        PUBLISHED: published ?? "",
        LATEST: latest,
      },
    });
    const calls = readFileSync(log, "utf8").trim();
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      published: calls === "" ? [] : calls.split("\n"),
    };
  }

  it("downloads the npm artifact outside the git checkout", () => {
    expect(publishJob).toContain("path: ${{ runner.temp }}/npm-package");
    expect(publishJob).toContain(
      "TARBALL: ${{ runner.temp }}/npm-package/${{ needs.verify.outputs.tarball }}"
    );
    expect(publishJob).not.toMatch(/path: npm-package/);
    expect(publishJob).not.toMatch(/TARBALL: npm-package/);
  });

  it("keeps the checkout that the provenance attestation needs", () => {
    expect(publishJob).toMatch(/uses: actions\/checkout@v\d/);
  });

  it("resolves the tag to a commit once and exposes it", () => {
    expect(prepareJob).toContain("sha: ${{ steps.version.outputs.sha }}");
    expect(prepareJob).toContain('git rev-parse --verify --quiet "refs/tags/$tag^{commit}"');
    expect(prepareJob).toContain('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
  });

  it("checks out the resolved commit in every job that builds, publishes, or releases", () => {
    expect(laterJobs).not.toContain("ref: ${{ github.ref }}");
    expect(laterJobs.match(/ref: \$\{\{ needs\.prepare\.outputs\.sha \}\}/g)).toHaveLength(4);
  });

  it("checks the version against the package.json of the resolved commit", () => {
    expect(prepareJob).toContain('git show "${sha}:package.json"');
    expect(prepareJob).toContain("--check-release-version");
  });

  it("stops the release when the tag no longer names the released commit", () => {
    const expected = stepScript(publishJob, "Verify the tag still names the released commit");
    expect(expected).toContain('ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}"');
    expect(expected).toContain('if [ "$current" != "$SHA" ]; then');
    for (const job of [imageJob, releaseJob]) {
      expect(stepScript(job, "Verify the tag still names the released commit")).toBe(expected);
    }
    const releaseSteps = releaseJob.slice(releaseJob.indexOf("    steps:"));
    expect(releaseSteps.indexOf("Verify the tag still names the released commit")).toBeLessThan(
      releaseSteps.indexOf("- name: Create GitHub Release")
    );
  });

  // The publish step is a shell script, so it runs against a fake npm.
  it.skipIf(process.platform === "win32")("skips the publish when npm prints the version in quotes", () => {
    const run = runPublishStep({ published: "'0.1.9'", latest: "'0.1.5'" });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/already on the npm registry; skipping publish/);
    expect(run.published).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("keeps latest when npm prints the latest dist-tag in quotes", () => {
    const run = runPublishStep({ published: null, latest: "'0.1.5'" });
    expect(run.status).toBe(0);
    expect(run.published).toHaveLength(1);
    expect(run.published[0]).toMatch(/--tag latest$/);
  });

  it("states the published version on the GitHub Release", () => {
    const releaseStep = releaseJob.slice(releaseJob.indexOf("- name: Create GitHub Release"));
    expect(releaseStep).toContain("tag_name: ${{ github.ref_name }}");
    expect(releaseStep).toContain("name: hq-jr ${{ needs.prepare.outputs.version }}");
    const body = releaseStep.slice(releaseStep.indexOf("body: |"));
    expect(body).toContain("## hq-jr ${{ needs.prepare.outputs.version }}");
    expect(body).toContain("npm install -g hq-jr@${{ needs.prepare.outputs.version }}");
    expect(body).toContain("docker pull ghcr.io/adi-il/hq-jr:${{ needs.prepare.outputs.version }}");
    expect(body).not.toContain("github.ref");
  });

  it("keeps same-tag runs apart and publishes on one channel", () => {
    const header = workflow.slice(0, workflow.indexOf("jobs:"));
    expect(header).toMatch(/concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false\n/);
    expect(header).not.toMatch(/group: release-version-channel/);
    const channel = [
      "    concurrency:",
      "      group: release-version-channel",
      "      cancel-in-progress: false",
      "      queue: max",
    ].join("\n");
    expect(publishJob).toContain(channel);
    expect(imageJob).toContain(channel);
    expect(releaseJob).not.toContain("release-version-channel");
    const prepareAndVerify = workflow.slice(workflow.indexOf("  prepare:"), workflow.indexOf("  publish-npm:"));
    expect(prepareAndVerify).not.toMatch(/group: release-version-channel/);
  });

  it("pushes the versioned image before it decides whether to move latest", () => {
    const built = imageJob.indexOf("- name: Build and push image");
    const decide = imageJob.indexOf("- name: Decide whether this release is the latest");
    const move = imageJob.indexOf("- name: Move the latest tag");
    expect(built).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(built);
    expect(move).toBeGreaterThan(decide);
    expect(imageJob.slice(decide, move)).not.toMatch(/\n {6}- name:/);
    const metadata = imageJob.slice(
      imageJob.indexOf("- name: Extract Docker metadata"),
      built
    );
    expect(metadata).toContain("latest=false");
    expect(metadata).not.toContain("value=latest");
    const moveStep = imageJob.slice(move);
    expect(moveStep).toContain("if: steps.latest.outputs.latest == 'true'");
    expect(moveStep).toContain('docker buildx imagetools create');
    expect(moveStep).toContain('"$REGISTRY/$IMAGE_NAME:$VERSION"');
    const publishStep = publishJob.slice(publishJob.indexOf("- name: Publish to npm"));
    const distTag = publishStep.indexOf("dist_tag=latest");
    const npmPublish = publishStep.indexOf("npm publish");
    expect(distTag).toBeGreaterThan(-1);
    expect(npmPublish).toBeGreaterThan(distTag);
    expect(publishStep.slice(distTag, npmPublish)).not.toContain("- name:");
  });

  it.skipIf(process.platform === "win32")("leaves latest in place when a newer tag is already on origin", () => {
    const run = runLatestDecision({
      version: "0.1.9",
      tags: "aaa refs/tags/v0.1.9\nbbb refs/tags/v0.2.0\n",
    });
    expect(run.status).toBe(0);
    expect(run.output).toBe("latest=false\n");
    expect(run.stdout).toMatch(/0\.1\.9 is older than 0\.2\.0/);
  });

  it.skipIf(process.platform === "win32")("moves latest when this version is the highest tag", () => {
    const run = runLatestDecision({
      version: "0.2.0",
      tags: "aaa refs/tags/v0.1.9\nbbb refs/tags/v0.2.0\n",
    });
    expect(run.status).toBe(0);
    expect(run.output).toBe("latest=true\n");
    expect(run.stdout).toMatch(/0\.2\.0 is the highest release tag/);
  });
});

function runLatestDecision({ version, tags }) {
  const root = mkdtempSync(path.join(tmpdir(), "release-latest-"));
  const bin = path.join(root, "bin");
  const output = path.join(root, "github-output");
  mkdirSync(bin);
  writeFileSync(output, "");
  writeFileSync(
    path.join(bin, "git"),
    [
      "#!/bin/sh",
      'if [ "$1" = "ls-remote" ] && [ "$2" = "--tags" ]; then',
      '  printf "%s" "$TAGS"',
      "  exit 0",
      "fi",
      'echo "unexpected git $*" >&2',
      "exit 1",
      "",
    ].join("\n")
  );
  chmodSync(path.join(bin, "git"), 0o755);
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const imageJob = workflow.slice(workflow.indexOf("  publish-image:"), workflow.indexOf("  create-release:"));
  const step = imageJob.slice(imageJob.indexOf("- name: Decide whether this release is the latest"));
  const lines = step.slice(step.indexOf("        run: |")).split("\n").slice(1);
  const scriptLines = [];
  for (const line of lines) {
    if (line.trim() && !line.startsWith("          ")) break;
    scriptLines.push(line.slice(10));
  }
  const script = path.join(root, "latest.sh");
  writeFileSync(script, scriptLines.join("\n"));
  try {
    const result = spawnSync("bash", [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        VERSION: version,
        GITHUB_OUTPUT: output,
        TAGS: tags,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
