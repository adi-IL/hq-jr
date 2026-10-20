#!/usr/bin/env node
/**
 * Compute, apply, commit, and tag the next patch release.
 *
 * The release workflow is tag driven, so the version bump happens here on a
 * maintainer machine before the tag is pushed. The next version is
 * patch(max(package.json version, npm latest version)).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  console.error(`bump-version: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage: node scripts/bump-version.mjs [options]

Computes the next patch version as patch(max(package.json version, npm latest)),
writes it into package.json, commits it, and creates the annotated tag vX.Y.Z.

Options:
  --dry-run   Print the plan without writing, committing, or tagging.
  --help      Show this message and exit.
`);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function npm(args) {
  return execFileSync("npm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function readNpmLatest(name) {
  let stdout;
  try {
    stdout = npm(["view", name, "version"]);
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (/E404/.test(stderr)) return null;
    fail(`could not read the npm registry version of '${name}':\n${stderr.trim()}`);
  }
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const versions = [];
  for (const line of lines) {
    const match = SEMVER.exec(line);
    if (!match) {
      fail(
        `npm latest for '${name}' is '${line}', which is not a plain X.Y.Z version. ` +
          "Resolve the registry state by hand before releasing."
      );
    }
    versions.push({ raw: line, parts: match.slice(1).map(Number) });
  }
  versions.sort((a, b) => compare(a.parts, b.parts));
  return versions[versions.length - 1];
}

function readNpmRepositoryUrl(name) {
  try {
    const stdout = npm(["view", name, "repository.url"]);
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const value = lines[lines.length - 1];
    return value && value !== "undefined" ? value : null;
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
let dryRun = false;
for (const arg of args) {
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  }
  if (arg === "--dry-run") {
    dryRun = true;
    continue;
  }
  fail(`unknown argument '${arg}'. Run with --help for usage.`);
}

const raw = readFileSync(packageJsonPath, "utf8");
let pkg;
try {
  pkg = JSON.parse(raw);
} catch (error) {
  fail(`package.json is not valid JSON: ${error.message}`);
}

const name = pkg.name;
const current = pkg.version;
const currentMatch = SEMVER.exec(String(current ?? ""));
if (!currentMatch) {
  fail(
    `package.json version '${current}' is not a plain X.Y.Z version. ` +
      "Set it by hand before releasing."
  );
}
const currentParts = currentMatch.slice(1).map(Number);

const npmLatest = readNpmLatest(name);
if (npmLatest) {
  const repositoryUrl = readNpmRepositoryUrl(name);
  if (repositoryUrl && !repositoryUrl.toLowerCase().includes("adi-il/hq-jr")) {
    fail(
      `the npm package '${name}' points at ${repositoryUrl}, not at this repository. ` +
        "Refusing to bump a package this repository does not own."
    );
  }
}

const base = npmLatest && compare(npmLatest.parts, currentParts) > 0 ? npmLatest.parts : currentParts;
const nextVersion = [base[0], base[1], base[2] + 1].join(".");
const tag = `v${nextVersion}`;

const status = git(["status", "--porcelain"]);
const dirty = status.split("\n").filter(Boolean);
if (dirty.length > 0) {
  fail(
    `the working tree has uncommitted changes:\n${dirty.join("\n")}\n` +
      "Commit or stash them before releasing."
  );
}

if (git(["tag", "--list", tag]).trim() !== "") {
  fail(`tag ${tag} already exists locally. Choose a different version or delete the tag first.`);
}

let remoteHasTag = false;
try {
  const listed = execFileSync("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  remoteHasTag = listed.trim() !== "";
} catch (error) {
  remoteHasTag = error.status === 0;
}
if (remoteHasTag) {
  fail(`tag ${tag} already exists on origin. Publishing it again is not possible.`);
}

console.log("Release plan");
console.log(`  package name:   ${name}`);
console.log(`  package.json:   ${current}`);
console.log(`  npm latest:     ${npmLatest ? npmLatest.raw : "(not published yet)"}`);
console.log(`  next version:   ${nextVersion}`);
console.log(`  commit message: chore: release ${nextVersion} [skip release]`);
console.log(`  tag:            ${tag} (annotated)`);

if (dryRun) {
  console.log("\nDry run: nothing was written, committed, or tagged.");
  process.exit(0);
}

const versionFields = raw.match(/("version"\s*:\s*")[^"]*(")/g) ?? [];
if (versionFields.length !== 1) {
  fail(
    `expected exactly one version field in package.json, found ${versionFields.length}. ` +
      "Update the version by hand."
  );
}
const serialized = `${JSON.stringify({ ...pkg, version: nextVersion }, null, 2)}\n`;
const updated =
  serialized === raw
    ? serialized
    : raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${nextVersion}$2`);
if (JSON.parse(updated).version !== nextVersion) {
  fail("could not write the new version into package.json");
}
writeFileSync(packageJsonPath, updated);

try {
  git(["add", "package.json"]);
  git(["commit", "-m", `chore: release ${nextVersion} [skip release]`]);
  git(["tag", "-a", tag, "-m", `hq-jr ${nextVersion}`]);
} catch (error) {
  const stderr = String(error.stderr ?? "");
  fail(`git failed while committing or tagging:\n${stderr.trim() || error.message}`);
}

const sha = git(["rev-parse", "--short", "HEAD"]).trim();
console.log(`\nCreated commit ${sha} and annotated tag ${tag}.`);
console.log("Push them with:");
console.log(`  git push origin HEAD`);
console.log(`  git push origin ${tag}`);
console.log(`Pushing ${tag} starts the release workflow.`);
