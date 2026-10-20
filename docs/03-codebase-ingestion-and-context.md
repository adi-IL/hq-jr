# Codebase Ingestion and Context Pipeline

## Production Pipeline vs Phase 5 Roadmap

`hq-jr` is architected around two operational tiers:

1. **Active Production Pipeline (Implemented):** High-speed incremental PR diff ingestion. Fetches the diff through Octokit in `src/index.ts`, parses it in `diff-parser.ts`, applies heuristic noise rejection in `file-filter.ts`, redacts secrets from packaged diff text, tracks prior audit history (unresolved hq-jr GitHub threads first; latest hq-jr review comments plus SQLite `review_findings` when thread state is unavailable), and packages context for multi-tier Gemini evaluation.
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
| - Tag binaries and submodules (index line mode 160000)      |
| - Parse rename from/to and similarity index headers         |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Heuristic Noise & Extension Filter (src/services/file-filter.ts)
| - Skip lockfiles (package-lock.json, bun.lockb, Cargo.lock)  |
| - Skip compiled assets (dist/, build/, minified JS)         |
| - Skip type declaration files (*.d.ts)                      |
| - Include SVGs in frontend triage for stored XSS detection  |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Secret Redaction (src/services/scrubber.ts)                 |
| - Redact PATs (github_pat_), Anthropic/OpenAI keys, and JWTs|
| - Replace credentials with [REDACTED_SECRET] placeholders   |
| - Keep env and configuration reads intact                   |
|   (process.env.X, os.environ[...], config.X, getSecret())   |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Context Packager (src/services/context-packager.ts)         |
| - Rank the files by risk, then fit the payload to the budget|
| - Diff-text caps: 30,000/file, 120,000 total payload        |
| - Emit the prompt payload that the model call receives      |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Tier 1: Flash + High Thinking (src/services/ai.ts)          |
| - Triage schema: overall risk and shouldReview per file     |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Multi-Turn Review Memory (src/services/review-memory.ts)    |
| - Prefer unresolved hq-jr threads; review+SQLite fallback   |
| - Prior findings verify what a new push resolved            |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Tier 2: Deep Review (src/services/ai.ts)                    |
| - Flash + High Thinking, or Gemini 4 Argon above the risk   |
|   threshold                                                 |
+-------------------------------------------------------------+
```

---

## Context Window Optimization Rules

Large pull requests can exceed model limits. `hq-jr` applies character budgets and deterministic filters before any model call.

1. **Deterministic Ignore Rules** (`src/services/file-filter.ts`):
   - Documentation (`*.md`, `*.markdown`, `*.txt`, and any `docs/` directory segment).
   - Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `composer.lock`, `flake.lock`).
   - Asset binaries and archives (`*.png`, `*.jpg`, `*.wasm`, `*.bin`, `*.zip`, and similar).
   - TypeScript declaration files (`*.d.ts`).
   - Generated directories (`node_modules/`, `dist/`, `build/`, `out/`, `target/`, `.next/`, `vendor/`, `coverage/`).
   - Minified bundles (`*.min.*`, `*.bundle.js`).
   - The filter does not read `.gitignore`; it uses the fixed rules above.
   - Risk categories are decided from path words. A security root (`auth`, `credential`, `crypto`, `jwt`, `middleware`, `permission`, `rbac`, `secret`, `token`) counts anywhere inside a word, so `src/authservice.ts`, `src/basicauth.go` and `src/UnauthorizedError.ts` are treated as security code. Look-alike words such as `author`, `authority`, `tokenizer` and `secretary` do not count, so `src/AuthorProfile.tsx` is not treated as authentication code. Frontend terms must be whole words, so `src/server/reviewer.ts` is not treated as a frontend view.

2. **Truncation and Character Budgeting:**
   - Each formatted file diff is capped at 30,000 characters, and the truncation notice is part of that cap, so the room for the notice is taken off before the cut. The cut lands on a line boundary. A per-file cap that cannot hold one whole code line drops the file ("Per-file size limit leaves no whole line"). Secret replacement runs before the budget is measured, because the cap has to apply to the text that is actually emitted.
   - The emitted prompt payload is capped at 120,000 characters in total. The file lists, section headers and truncation notices count against that cap, so they are measured first and the diff content gets what is left, in risk order. The ignored file list may use at most a fifth of the budget. Entries past that are summarized in one line. A cut inside a file diff lands on a line boundary and ends with a truncation notice. When the section headers alone exceed the cap, no file is kept and the payload is cut on a line boundary. That metadata cut ends with a truncation notice when the cap has room for the notice. A cap shorter than the notice is cut on a line boundary and has no notice. If no complete line fits in that cap, the payload is empty.
   - A file that would not keep at least one line of code is reported as pruned ("Context window budget limit reached") instead of as a file to review. A binary file is pruned with the reason "Binary file has no reviewable text". Any other file with no hunk lines, including a hunk header with nothing under it, is pruned with the reason "No reviewable lines in the diff". A file whose hunks contain only unchanged context lines is still offered for review, because those lines are code the model can read. These three reasons apply to a path the filter accepted, so a file the filter dropped earlier, such as a PNG or a markdown file, is listed with the filter's own reason.
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
