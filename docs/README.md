# hq-jr Research and Architecture Documentation

This directory contains research, architectural designs, and implementation specifications for `hq-jr`, an automated whole-codebase and pull-request review bot.

## Document Directory

1. [System Architecture and Probot Framework](01-architecture-and-probot.md)
   Core event loop, webhook handling, review memory across commits, autonomous remediation, Octokit REST and GraphQL integration, and GitHub CLI workflow integration.

2. [Model Orchestration and Vertex AI ADC](02-model-orchestration-and-vertex-adc.md)
   Application Default Credentials (ADC) setup, multi-tier routing (Gemini 3.8 Flash with High Thinking, antigravity-preview-05-2026), token budgeting, and structured JSON output schemas.

3. [Codebase Ingestion and Context Pipeline](03-codebase-ingestion-and-context.md)
   Handling full codebase audits vs incremental PR diffs, tarball streaming vs shallow clones, Tree-sitter symbol indexing, and context window optimization.

4. [GitHub App Lifecycle, Permissions, and Security](04-github-app-lifecycle-and-security.md)
   Manifest-driven registration, granular permissions (`checks: write`, `pull_requests: write`, `contents: write`, `issues: write`, `metadata: read`), authentication mechanics, credential redaction, RBAC enforcement, and repository isolation.

5. [Deployment and Operations](05-deployment-and-operations.md)
   Google Cloud Run deployment with native IAM identity, local development with Smee.io, environment variable specifications, and rate-limit mitigation.
