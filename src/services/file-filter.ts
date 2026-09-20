export interface FilterResult {
  shouldIgnore: boolean;
  reason?: string;
  category: "SECURITY" | "BACKEND" | "FRONTEND" | "CONFIG" | "TEST" | "DOCUMENTATION" | "OTHER";
  riskWeight: number; // 1 to 10
}

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "flake.lock",
]);

const IGNORED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".pdf",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".map",
  ".d.ts",
]);

const IGNORED_DIRECTORY_PREFIXES = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".git/",
  ".next/",
  ".nuxt/",
  "vendor/",
  "coverage/",
  ".system_generated/",
];

/**
 * Categorizes and filters files to guard the context window and prevent reviewing noise.
 */
export function evaluateFile(filePath: string): FilterResult {
  const normalized = filePath.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() || "";
  const lower = normalized.toLowerCase();
  const ext = filename.includes(".") ? `.${filename.split(".").pop()?.toLowerCase()}` : "";

  // 1. Directory checks
  for (const prefix of IGNORED_DIRECTORY_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)) {
      return {
        shouldIgnore: true,
        reason: `Generated directory: ${prefix}`,
        category: "OTHER",
        riskWeight: 0,
      };
    }
  }

  // 2. Lockfile check
  if (LOCKFILES.has(filename)) {
    return {
      shouldIgnore: true,
      reason: `Dependency lockfile: ${filename}`,
      category: "CONFIG",
      riskWeight: 0,
    };
  }

  // 3. Ignored extensions (binaries, maps, types)
  if (IGNORED_EXTENSIONS.has(ext)) {
    return {
      shouldIgnore: true,
      reason: `Ignored binary/generated extension: ${ext}`,
      category: "OTHER",
      riskWeight: 0,
    };
  }

  // 4. Minified bundles
  if (filename.includes(".min.") || filename.endsWith(".bundle.js")) {
    return {
      shouldIgnore: true,
      reason: "Minified production artifact",
      category: "FRONTEND",
      riskWeight: 0,
    };
  }

  // 5. Documentation
  if (ext === ".md" || ext === ".markdown" || ext === ".txt" || normalized.startsWith("docs/")) {
    return {
      shouldIgnore: true,
      reason: "Documentation / markdown content",
      category: "DOCUMENTATION",
      riskWeight: 1,
    };
  }

  // 6. Security-critical paths
  if (
    lower.includes("auth") ||
    lower.includes("crypto") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("rbac") ||
    lower.includes("permission") ||
    lower.includes("middleware")
  ) {
    return {
      shouldIgnore: false,
      category: "SECURITY",
      riskWeight: 10,
    };
  }

  // 7. Tests
  if (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.startsWith("test/") ||
    lower.startsWith("tests/") ||
    lower.includes("/__tests__/")
  ) {
    return {
      shouldIgnore: false,
      category: "TEST",
      riskWeight: 3,
    };
  }

  // 8. Configuration
  if (
    filename === "package.json" ||
    filename === "tsconfig.json" ||
    filename.startsWith("Dockerfile") ||
    ext === ".yaml" ||
    ext === ".yml" ||
    ext === ".toml" ||
    ext === ".env"
  ) {
    return {
      shouldIgnore: false,
      category: "CONFIG",
      riskWeight: 5,
    };
  }

  // 9. Frontend vs Backend source
  if (
    lower.includes("component") ||
    lower.includes("view") ||
    lower.includes("page") ||
    ext === ".tsx" ||
    ext === ".jsx" ||
    ext === ".vue" ||
    ext === ".svelte" ||
    ext === ".svg"
  ) {
    return {
      shouldIgnore: false,
      category: "FRONTEND",
      riskWeight: 6,
    };
  }

  // Default to backend source code
  return {
    shouldIgnore: false,
    category: "BACKEND",
    riskWeight: 7,
  };
}
