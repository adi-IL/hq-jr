# Codebase Ingestion and Context Pipeline

## Production Pipeline vs Phase 5 Roadmap

`hq-jr` is architected around two operational tiers:

1. **Active Production Pipeline (Implemented):** High-speed incremental PR diff ingestion. Fetches the diff through Octokit in `src/index.ts`, parses it in `diff-parser.ts`, applies heuristic noise rejection in `file-filter.ts`, redacts secrets from packaged diff text, tracks prior audit history (unresolved hq-jr GitHub threads first, SQLite `review_findings` as fallback), and packages context for multi-tier Gemini evaluation.
2. **Phase 5 Advanced Roadmap (Planned):** Full-repository tarball streaming, shallow clones, Tree-Sitter AST symbol indexing, and dependency blast-radius mapping. The SQLite `symbol_cache` table and `symbol-cache.ts` helpers exist, but no review-flow caller populates or reads them yet.

---

## Active Production Ingestion: Unified Diff & Context Packaging

For live GitHub PR reviews, `hq-jr` uses GitHub installation tokens for API access and SQLite for durable review memory / run locks:

```
+-------------------------------------------------------------+
|                GitHub PR Webhook Trigger                    |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Octokit PR Diff Fetch + Parser                              |
|   src/index.ts -> src/services/diff-parser.ts               |
| - pulls.get with the diff media type                        |
| - Parse hunks, old/new line anchors, quoted paths           |
| - Tag binaries and submodules (mode 160000)                 |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Heuristic Noise & Extension Filter (src/services/file-filter.ts)
| - Skip lockfiles (package-lock.json, bun.lockb, Cargo.lock)  |
| - Skip compiled assets (dist/, build/, minified JS)         |
| - Include SVGs in frontend triage for stored XSS detection  |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Secret Redaction (src/services/scrubber.ts)                 |
| - Redact PATs (github_pat_), Anthropic/OpenAI keys, and JWTs|
| - Replace credentials with [REDACTED_SECRET] placeholders   |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Multi-Turn Review Memory (src/services/review-memory.ts)    |
| - Prefer unresolved hq-jr GitHub threads; SQLite fallback   |
| - active_runs locks; verify prior issues resolved on push   |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Context Packager & Vertex AI Evaluation (src/services/ai.ts)|
| - Character budgets: 30,000 per file, 120,000 total         |
| - Tier 1: Flash + High Thinking (triage schema)             |
| - Tier 2: Flash + High Thinking (deep review schema)        |
+-------------------------------------------------------------+
```

---

## Context Window Optimization Rules

Large pull requests can exceed model limits. `hq-jr` applies character budgets and deterministic filters before any model call.

1. **Deterministic Ignore Rules** (`src/services/file-filter.ts`):
   - Documentation (`*.md`, `*.markdown`, `*.txt`, `docs/**`).
   - Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `composer.lock`, `flake.lock`).
   - Asset binaries and archives (`*.png`, `*.jpg`, `*.wasm`, `*.bin`, `*.zip`, and similar).
   - Generated directories (`node_modules/`, `dist/`, `build/`, `out/`, `target/`, `.next/`, `vendor/`, `coverage/`).
   - Minified bundles (`*.min.*`, `*.bundle.js`).
   - The filter does not read `.gitignore`; it uses the fixed rules above.

2. **Truncation and Character Budgeting:**
   - Each file is capped at 30,000 characters. The total payload is capped at 120,000 characters. Both caps add a truncation notice.
   - Long developer discussion replies keep the root turn plus the latest 8 turns, at 1,500 characters per turn.

---

## Phase 5 Roadmap: Whole-Codebase Ingestion & AST Indexing

The following features are designed for future full-codebase repository audits:

### 1. Repository Ingestion Strategies
- **Tarball Streaming:** `GET /repos/{owner}/{repo}/tarball/{ref}` streaming gzipped archives for full scans without git binary dependencies.
- **Shallow Clone:** `git clone --depth 1` into ephemeral ramdisk for massive repositories.

### 2. Tree-Sitter Symbol Extraction & Blast Radius
- Parsing source files with Tree-Sitter grammar bindings to identify function declarations, classes, and exported interfaces.
- Mapping cross-file dependency call-sites to detect when changing a signature breaks external consumers across the repository.

### 3. SQLite Symbol Cache (Present, Not Wired)
- `src/services/db.ts` creates `symbol_cache (repo, commit_sha, file_path, content_hash, symbols_json, created_at)` with primary key `(repo, commit_sha, file_path)`.
- `src/services/symbol-cache.ts` provides read/write helpers, but no production review path calls them yet. The table is groundwork for avoiding repeated parsing once whole-repository ingestion lands.
