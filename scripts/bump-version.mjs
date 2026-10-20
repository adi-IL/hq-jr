#!/usr/bin/env node
/**
 * Compute, apply, commit, and tag the next patch release.
 *
 * The release workflow is tag driven, so the version bump happens here on a
 * maintainer machine before the tag is pushed. The next version is
 * patch(max(package.json version, npm latest version)).
 *
 * Every check fails closed: when the registry, the remote, or git cannot be
 * read, the script stops instead of guessing.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
// npm package names: an optional @scope/ and then lowercase URL-safe characters.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

export class ReleaseError extends Error {}

export function parseSemver(value) {
  const match = SEMVER.exec(String(value ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

export function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** patch(max(current, npmLatest)). npmLatest is null when the package is not published yet. */
export function computeNextVersion(current, npmLatest) {
  const currentParts = parseSemver(current);
  if (!currentParts) {
    throw new ReleaseError(
      `package.json version '${current}' is not a plain X.Y.Z version. Set it by hand before releasing.`
    );
  }
  let base = currentParts;
  if (npmLatest !== null && npmLatest !== undefined) {
    const latestParts = parseSemver(npmLatest);
    if (!latestParts) {
      throw new ReleaseError(
        `npm latest is '${npmLatest}', which is not a plain X.Y.Z version. ` +
          "Resolve the registry state by hand before releasing."
      );
    }
    if (compareSemver(latestParts, currentParts) > 0) base = latestParts;
  }
  return [base[0], base[1], base[2] + 1].join(".");
}

/** Highest X.Y.Z version printed by `npm view <name> version`, or null when it printed nothing. */
export function pickNpmLatest(stdout) {
  const lines = String(stdout)
    .split("\n")
    .map((line) => line.trim().replace(/^'(.*)'$/, "$1"))
    .filter(Boolean);
  if (lines.length === 0) return null;
  let best = null;
  for (const line of lines) {
    const parts = parseSemver(line);
    if (!parts) {
      throw new ReleaseError(
        `npm latest is '${line}', which is not a plain X.Y.Z version. ` +
          "Resolve the registry state by hand before releasing."
      );
    }
    if (best === null || compareSemver(parts, best.parts) > 0) best = { raw: line, parts };
  }
  return best.raw;
}

/**
 * Canonical lowercase "owner/repo" for a GitHub repository URL, or null when the
 * value is not a GitHub repository URL. Accepts the forms npm stores:
 * git+https://github.com/o/r.git, https://github.com/o/r, git://github.com/o/r.git,
 * git+ssh://git@github.com/o/r.git, git@github.com:o/r.git, github:o/r, and o/r.
 */
export function githubRepositorySlug(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const segment = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
  const repo = "[A-Za-z0-9._-]+?";
  const shorthand = new RegExp(`^(?:github:)?(${segment})/(${repo})(?:\\.git)?$`).exec(trimmed);
  if (shorthand) return `${shorthand[1]}/${shorthand[2]}`.toLowerCase();
  const scpLike = new RegExp(`^[A-Za-z0-9._-]+@github\\.com:(${segment})/(${repo})(?:\\.git)?/?$`, "i").exec(
    trimmed
  );
  if (scpLike) return `${scpLike[1]}/${scpLike[2]}`.toLowerCase();

  let parsed;
  try {
    parsed = new URL(trimmed.replace(/^git\+/, ""));
  } catch {
    return null;
  }
  if (!["https:", "http:", "git:", "ssh:"].includes(parsed.protocol)) return null;
  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (parsed.search || parsed.hash) return null;
  const parts = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2) return null;
  if (!new RegExp(`^${segment}$`).test(parts[0]) || !/^[A-Za-z0-9._-]+$/.test(parts[1])) return null;
  return parts.join("/").toLowerCase();
}

/** Throws unless the registry package points at the same GitHub repository as package.json. */
export function assertSameRepository(name, registryUrl, localRepository) {
  const localUrl = typeof localRepository === "string" ? localRepository : localRepository?.url;
  const localSlug = githubRepositorySlug(localUrl);
  if (!localSlug) {
    throw new ReleaseError(
      `package.json has no GitHub repository URL (found '${localUrl ?? ""}'), ` +
        `so the owner of the npm package '${name}' cannot be checked.`
    );
  }
  if (!registryUrl) {
    throw new ReleaseError(
      `the npm package '${name}' has no repository URL, so it cannot be matched to ${localSlug}. ` +
        "Refusing to bump a package this repository may not own."
    );
  }
  const registrySlug = githubRepositorySlug(registryUrl);
  if (registrySlug !== localSlug) {
    throw new ReleaseError(
      `the npm package '${name}' points at ${registryUrl}, not at ${localSlug}. ` +
        "Refusing to bump a package this repository does not own."
    );
  }
}

/**
 * `git ls-remote --exit-code` exits 0 when the ref exists and 2 when it does not.
 * Any other status means the remote could not be read.
 */
export function remoteTagExists(status, tag, stderr = "") {
  if (status === 0) return true;
  if (status === 2) return false;
  const detail = String(stderr).trim();
  throw new ReleaseError(
    `could not check for tag ${tag} on origin (git exit ${status ?? "unknown"})` +
      `${detail ? `:\n${detail}` : ""}\nFix access to origin and run the script again.`
  );
}

function detectJsonFormat(raw) {
  const indent = /^[{[]\r?\n([ \t]+)/.exec(raw)?.[1] ?? "  ";
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  return { indent, newline };
}

function serializeJson(value, raw) {
  const { indent, newline } = detectJsonFormat(raw);
  return `${JSON.stringify(value, null, indent).replace(/\n/g, newline)}${newline}`;
}

function parseJson(raw, file) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ReleaseError(`${file} is not valid JSON: ${error.message}`);
  }
}

/** package.json text with the version replaced, in the file's own indentation and line endings. */
export function setPackageVersion(raw, version) {
  const pkg = parseJson(raw, "package.json");
  pkg.version = version;
  return serializeJson(pkg, raw);
}

/** package-lock.json text with both root version fields replaced. */
export function setLockfileVersion(raw, name, version) {
  const lock = parseJson(raw, "package-lock.json");
  if (lock.name !== name) {
    throw new ReleaseError(
      `package-lock.json is for '${lock.name}', not '${name}'. Run npm install to regenerate it.`
    );
  }
  const root = lock.packages?.[""];
  if (lock.lockfileVersion >= 2 && !root) {
    throw new ReleaseError(
      'package-lock.json has no packages[""] entry. Run npm install to regenerate it.'
    );
  }
  lock.version = version;
  if (root) root.version = version;
  return serializeJson(lock, raw);
}

export function releaseSubject(version) {
  return `chore: release ${version} [skip release]`;
}

function usage() {
  console.log(`Usage: node scripts/bump-version.mjs [options]

Computes the next patch version as patch(max(package.json version, npm latest)),
writes it into package.json and package-lock.json, commits both, and creates the
annotated tag vX.Y.Z.

Options:
  --dry-run   Print the plan without writing, committing, or tagging.
  --help      Show this message and exit.
`);
}

function stderrOf(error) {
  return String(error?.stderr ?? "").trim() || String(error?.message ?? error);
}

export function main(argv, repoRoot) {
  const run = (file, args) =>
    execFileSync(file, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const git = (args) => run("git", args);
  const npm = (args) => {
    if (process.platform === "win32") {
      // npm is npm.cmd on Windows, and Node runs .cmd files only through a shell.
      // Every argument is a fixed word or a validated package name, so joining them is safe.
      return execSync(`npm ${args.join(" ")}`, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    return run("npm", args);
  };

  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      usage();
      return;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    throw new ReleaseError(`unknown argument '${arg}'. Run with --help for usage.`);
  }

  const packageJsonPath = path.join(repoRoot, "package.json");
  const lockfilePath = path.join(repoRoot, "package-lock.json");
  const rawPackage = readFileSync(packageJsonPath, "utf8");
  const pkg = parseJson(rawPackage, "package.json");
  const name = pkg.name;
  const current = pkg.version;
  if (typeof name !== "string" || !PACKAGE_NAME.test(name)) {
    throw new ReleaseError(`package.json name '${name}' is not a valid npm package name.`);
  }
  if (!parseSemver(current)) {
    throw new ReleaseError(
      `package.json version '${current}' is not a plain X.Y.Z version. Set it by hand before releasing.`
    );
  }
  const rawLock = existsSync(lockfilePath) ? readFileSync(lockfilePath, "utf8") : null;

  const status = git(["status", "--porcelain"]);
  const dirty = status.split("\n").filter(Boolean);
  if (dirty.length > 0) {
    throw new ReleaseError(
      `the working tree has uncommitted changes:\n${dirty.join("\n")}\nCommit or stash them before releasing.`
    );
  }

  const localTagExists = (tag) => git(["tag", "--list", tag]).trim() !== "";

  // A release commit without its tag means an earlier run stopped halfway.
  // Bumping again would skip that version, so stop and say how to finish it.
  const headSubject = git(["log", "-1", "--format=%s"]).trim();
  if (headSubject === releaseSubject(current) && !localTagExists(`v${current}`)) {
    throw new ReleaseError(
      `HEAD is the release commit for ${current}, but tag v${current} does not exist locally.\n` +
        "Finish that release instead of bumping again:\n" +
        `  git tag -a v${current} -m "hq-jr ${current}"   (or git fetch --tags if origin has it)\n` +
        `Or drop the release commit with: git reset --keep HEAD~1`
    );
  }

  let npmLatest = null;
  try {
    npmLatest = pickNpmLatest(npm(["view", name, "version"]));
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    if (!/E404/.test(String(error.stderr ?? ""))) {
      throw new ReleaseError(`could not read the npm registry version of '${name}':\n${stderrOf(error)}`);
    }
  }

  if (npmLatest) {
    let registryUrl;
    try {
      registryUrl = pickLastLine(npm(["view", name, "repository.url"]));
    } catch (error) {
      throw new ReleaseError(
        `could not read the npm repository metadata of '${name}':\n${stderrOf(error)}\n` +
          "The owner check cannot run, so the release stops here."
      );
    }
    assertSameRepository(name, registryUrl, pkg.repository);
  }

  const nextVersion = computeNextVersion(current, npmLatest);
  const tag = `v${nextVersion}`;
  const subject = releaseSubject(nextVersion);

  if (localTagExists(tag)) {
    throw new ReleaseError(`tag ${tag} already exists locally. Choose a different version or delete the tag first.`);
  }

  let lsRemoteStatus = 0;
  let lsRemoteStderr = "";
  try {
    git(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]);
  } catch (error) {
    lsRemoteStatus = error.status;
    lsRemoteStderr = String(error.stderr ?? error.message ?? "");
  }
  if (remoteTagExists(lsRemoteStatus, tag, lsRemoteStderr)) {
    throw new ReleaseError(`tag ${tag} already exists on origin. Publishing it again is not possible.`);
  }

  // Build both files before the plan so --dry-run catches a bad lockfile too.
  const updatedPackage = setPackageVersion(rawPackage, nextVersion);
  const updatedLock = rawLock === null ? null : setLockfileVersion(rawLock, name, nextVersion);
  const files = rawLock === null ? ["package.json"] : ["package.json", "package-lock.json"];
  console.log("Release plan");
  console.log(`  package name:   ${name}`);
  console.log(`  package.json:   ${current}`);
  console.log(`  npm latest:     ${npmLatest ?? "(not published yet)"}`);
  console.log(`  next version:   ${nextVersion}`);
  console.log(`  files:          ${files.join(", ")}`);
  console.log(`  commit message: ${subject}`);
  console.log(`  tag:            ${tag} (annotated)`);

  if (dryRun) {
    console.log("\nDry run: nothing was written, committed, or tagged.");
    return;
  }

  const headBefore = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(packageJsonPath, updatedPackage);
  if (updatedLock !== null) writeFileSync(lockfilePath, updatedLock);

  try {
    git(["add", "--", ...files]);
    git(["commit", "-m", subject]);
  } catch (error) {
    let headAfter = headBefore;
    try {
      headAfter = git(["rev-parse", "HEAD"]).trim();
    } catch {
      // Keep headBefore; the restore below is still correct when nothing was committed.
    }
    if (headAfter === headBefore) {
      writeFileSync(packageJsonPath, rawPackage);
      if (rawLock !== null) writeFileSync(lockfilePath, rawLock);
      try {
        git(["reset", "-q", "--", ...files]);
      } catch {
        // The working tree is restored either way; git status shows any staged leftovers.
      }
      throw new ReleaseError(
        `git could not commit the release:\n${stderrOf(error)}\n` +
          `${files.join(" and ")} were restored. Nothing was committed or tagged.`
      );
    }
    throw new ReleaseError(
      `git reported an error after creating commit ${headAfter.slice(0, 12)}:\n${stderrOf(error)}\n` +
        `Check the commit, then create the tag with: git tag -a ${tag} -m "hq-jr ${nextVersion}"`
    );
  }

  const sha = git(["rev-parse", "--short", "HEAD"]).trim();
  try {
    git(["tag", "-a", tag, "-m", `hq-jr ${nextVersion}`]);
  } catch (error) {
    throw new ReleaseError(
      `created commit ${sha} (${subject}) but git could not create tag ${tag}:\n${stderrOf(error)}\n` +
        `The branch now carries version ${nextVersion} with no tag. Do not run this script again until that is fixed.\n` +
        `Create the tag by hand: git tag -a ${tag} -m "hq-jr ${nextVersion}"\n` +
        `Or drop the release commit: git reset --keep HEAD~1`
    );
  }

  console.log(`\nCreated commit ${sha} and annotated tag ${tag}.`);
  console.log("Push them with:");
  console.log("  git push origin HEAD");
  console.log(`  git push origin ${tag}`);
  console.log(`Pushing ${tag} starts the release workflow.`);
}

function pickLastLine(stdout) {
  const lines = String(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const value = lines[lines.length - 1];
  return value && value !== "undefined" ? value : null;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    main(process.argv.slice(2), repoRoot);
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    console.error(`bump-version: ${error.message}`);
    process.exit(1);
  }
}
