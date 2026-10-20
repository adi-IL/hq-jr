#!/usr/bin/env node
/**
 * Fail when the npm package would ship a secret-shaped or local-state file.
 *
 * Usage:
 *   node scripts/check-package-contents.mjs                 runs `npm pack --dry-run --json`
 *   node scripts/check-package-contents.mjs <report.json>   reads the JSON report of `npm pack --json`
 *
 * CI runs it on every branch and the release workflow runs it on the tarball it publishes.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Data-file extensions that a credentials file can have. Code files such as
// dist/credentials-store.js or .d.ts are not on the list, so they still pass.
const DATA_EXTENSIONS = "json|ya?ml|toml|ini|cfg|conf|txt|xml|properties|env";

export const FORBIDDEN = [
  { pattern: /(^|\/)\.env$/, reason: "dotenv file" },
  { pattern: /(^|\/)\.env\.(?!example$)/, reason: "dotenv file" },
  { pattern: /(^|\/)\.npmrc$/, reason: "npm config, may hold a token" },
  { pattern: /(^|\/)\.netrc$/, reason: "netrc file, may hold a password" },
  { pattern: /\.(pem|key|cert|crt|p12|pfx|p8|jks|keystore)$/i, reason: "key or certificate" },
  { pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, reason: "SSH private key" },
  { pattern: /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i, reason: "database file" },
  { pattern: /(^|\/)application_default_credentials\.json$/i, reason: "Google ADC file" },
  { pattern: /(^|\/)adc\.json$/i, reason: "Google ADC file" },
  { pattern: /(^|\/)gcloud\//, reason: "file under a gcloud directory" },
  { pattern: /(^|\/)[^/]*service[-_]?account[^/]*\.json$/i, reason: "service account key" },
  { pattern: /(^|\/)\.?credentials$/i, reason: "credentials file" },
  { pattern: new RegExp(`(^|/)[^/]*credentials[^/]*\\.(${DATA_EXTENSIONS})$`, "i"), reason: "credentials file" },
];

/** Paths from the JSON report that `npm pack --json` prints. */
export function filesFromPackReport(report) {
  if (!Array.isArray(report) || report.length === 0 || !Array.isArray(report[0]?.files)) {
    throw new Error("the npm pack report has no file list");
  }
  // A real package always holds at least package.json, so an empty list means a broken report.
  if (report[0].files.length === 0) {
    throw new Error("the npm pack report lists no files");
  }
  return report[0].files.map((file) => file.path);
}

/** The forbidden entries in a list of package paths, each with the reason it is forbidden. */
export function forbiddenFiles(paths) {
  const bad = [];
  for (const file of paths) {
    const normalized = file.replace(/\\/g, "/");
    const rule = FORBIDDEN.find(({ pattern }) => pattern.test(normalized));
    if (rule) bad.push({ path: file, reason: rule.reason });
  }
  return bad;
}

function packReport(repoRoot) {
  const options = { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };
  // npm is npm.cmd on Windows, and Node runs .cmd files only through a shell.
  const stdout =
    process.platform === "win32"
      ? execSync("npm pack --dry-run --json", options)
      : execFileSync("npm", ["pack", "--dry-run", "--json"], options);
  return JSON.parse(stdout);
}

function main(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const report = argv[0] ? JSON.parse(readFileSync(argv[0], "utf8")) : packReport(repoRoot);
  const files = filesFromPackReport(report);
  const bad = forbiddenFiles(files);
  if (bad.length > 0) {
    console.error("Forbidden files in the npm package:");
    for (const { path: file, reason } of bad) console.error(`  ${file} (${reason})`);
    process.exit(1);
  }
  console.log(`npm package holds ${files.length} files, none of them forbidden`);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main(process.argv.slice(2));
