# Codebase Ingestion and Context Pipeline

## Production Pipeline vs Phase 5 Roadmap

`hq-jr` is architected around two operational tiers:

1. **Active Production Pipeline (Implemented):** High-speed, stateless incremental PR diff ingestion. Parses GitHub unified diffs directly via Octokit, applies heuristic noise rejection, redacts secrets, calculates line anchors, tracks prior audit history via `review-memory.ts`, and packages context for multi-tier Gemini evaluation.
2. **Phase 5 Advanced Roadmap (Planned):** Full-repository tarball streaming, local Tree-Sitter AST symbol indexing, dependency blast radius mapping, and persistent SQLite caching.

---

## Active Production Ingestion: Unified Diff & Context Packaging

For all live GitHub PR reviews, `hq-jr` operates entirely in memory using GitHub installation tokens:

```
+-------------------------------------------------------------+
|                GitHub PR Webhook Trigger                    |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Octokit Diff Stream (src/services/diff-parser.ts)           |
| - GET /repos/{owner}/{repo}/pulls/{number} (diff format)    |
| - Parse hunks, old/new line anchors, quoted paths with space|
| - Filter binary files and Git submodules (mode 160000)      |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Heuristic Noise & Extension Filter (src/services/file-filter.ts)
| - Skip lockfiles (package-lock.json, bun.lock, Cargo.lock)  |
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
| - Paginate prior bot reviews on the PR                      |
| - Verify whether new commits resolve previously open issues |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| Context Packager & Vertex AI Evaluation (src/services/ai.ts)|
| - Budget token limits per file                              |
| - Tier 1: Gemini 3.8 Flash Fast Triage                      |
| - Tier 2: Gemini 3.8 Flash High Thinking Deep Audit         |
+-------------------------------------------------------------+
```

---

## Context Window Optimization Rules

Large pull requests can easily exceed model token limits. `hq-jr` applies strict budgeting per `principle-guard-the-context-window`:

1. **Deterministic Ignore Rules:** Skips files matching `.gitignore` and noise heuristics:
   - Documentation (`*.md`, `*.txt`, `docs/**`).
   - Lockfiles (`package-lock.json`, `bun.lock`, `Cargo.lock`, `pnpm-lock.yaml`).
   - Asset binaries (`*.png`, `*.jpg`, `*.wasm`, `*.bin`).
   - Generated code (`dist/**`, `build/**`, `*.min.js`).

2. **Truncation and Token Budgeting:**
   - Diffs larger than 120,000 characters are pre-truncated with truncation notices to avoid regex denial-of-service in secret scrubbers.
   - Long developer discussion replies are constrained via a sliding window (root turn + latest 8 turns, max 1,500 chars/turn).

---

## Phase 5 Roadmap: Whole-Codebase Ingestion & AST Indexing

The following features are designed for future full-codebase repository audits:

### 1. Repository Ingestion Strategies
- **Tarball Streaming:** `GET /repos/{owner}/{repo}/tarball/{ref}` streaming gzipped archives for full scans without git binary dependencies.
- **Shallow Clone:** `git clone --depth 1` into ephemeral ramdisk for massive repositories.

### 2. Tree-Sitter Symbol Extraction & Blast Radius
- Parsing source files with Tree-Sitter grammar bindings to identify function declarations, classes, and exported interfaces.
- Mapping cross-file dependency call-sites to detect when changing a signature breaks external consumers across the repository.

### 3. SQLite Cache Persistence
- Maintaining an on-disk cache `(repo_id, commit_sha, file_path, content_hash, symbols_json)` to avoid re-parsing unchanged files across commit iterations.
