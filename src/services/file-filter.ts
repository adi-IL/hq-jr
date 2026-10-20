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
 * Security terms match a whole path word or the prefix of a compound word, so
 * "authservice" is authentication code while "AuthorProfile" is not.
 */
const SECURITY_ROOTS = [
  "auth",
  "authn",
  "authz",
  "authentication",
  "authorization",
  "authorisation",
  "authorize",
  "authenticator",
  "authenticate",
  "authenticated",
  "oauth",
  "token",
  "secret",
  "secretmanager",
  "crypto",
  "rbac",
  "permission",
  "middleware",
  "jwt",
  "credential",
  "credentials",
];

/**
 * Words that start with a security root but describe authorship or authority.
 */
const NON_SECURITY_PREFIXES = ["author", "authority"];

const SECURITY_ROOTS_BY_LENGTH = [...SECURITY_ROOTS].sort((a, b) => b.length - a.length);

const FRONTEND_TERMS = new Set([
  "component",
  "components",
  "page",
  "pages",
  "view",
  "views",
]);

/**
 * Splits a path into lowercase words: on separators and on camel case
 * boundaries, so "useAuthor.ts" yields "use" and "author".
 */
function tokenizePath(normalizedPath: string): string[] {
  const tokens: string[] = [];
  for (const segment of normalizedPath.split("/")) {
    if (!segment) {
      continue;
    }
    const withoutExtension = segment.replace(/\.[A-Za-z0-9]+$/, "");
    for (const part of withoutExtension.split(/[^A-Za-z0-9]+/)) {
      if (!part) {
        continue;
      }
      for (const word of part.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
        if (word) {
          tokens.push(word.toLowerCase());
        }
      }
    }
  }
  return tokens;
}

/**
 * A path token is security critical when a security root matches it as a
 * whole word or as the prefix of a compound word. The longest matching root
 * wins, so "authorization" stays security code while "author" does not.
 */
function isSecurityToken(token: string): boolean {
  for (const root of SECURITY_ROOTS_BY_LENGTH) {
    if (!token.startsWith(root)) {
      continue;
    }
    if (root === "auth" && NON_SECURITY_PREFIXES.some((prefix) => token.startsWith(prefix))) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Categorizes and filters files to guard the context window and prevent reviewing noise.
 */
export function evaluateFile(filePath: string): FilterResult {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const filename = segments.length > 0 ? segments[segments.length - 1] : "";
  const lowerFilename = filename.toLowerCase();
  const lower = normalized.toLowerCase();
  const ext = lowerFilename.includes(".") ? `.${lowerFilename.split(".").pop()}` : "";
  // TypeScript declaration files carry two suffixes, so they need their own match.
  const declarationExtension = lowerFilename.endsWith(".d.ts") ? ".d.ts" : "";

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
  if (IGNORED_EXTENSIONS.has(ext) || IGNORED_EXTENSIONS.has(declarationExtension)) {
    return {
      shouldIgnore: true,
      reason: `Ignored binary/generated extension: ${declarationExtension || ext}`,
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
  const directorySegments = segments.slice(0, -1);
  const isDocsDirectory = directorySegments.some((segment) => segment.toLowerCase() === "docs");
  if (ext === ".md" || ext === ".markdown" || ext === ".txt" || isDocsDirectory) {
    return {
      shouldIgnore: true,
      reason: "Documentation / markdown content",
      category: "DOCUMENTATION",
      riskWeight: 1,
    };
  }

  const pathTokens = tokenizePath(normalized);

  // 6. Security-critical paths
  if (pathTokens.some((token) => isSecurityToken(token))) {
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
    pathTokens.some((token) => FRONTEND_TERMS.has(token)) ||
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
