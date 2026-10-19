# hq-jr Research and Architecture Documentation

This directory contains architecture, implementation, and operations documentation for `hq-jr`, a self-hosted GitHub App that reviews pull request diffs with Vertex AI. Whole-codebase review is a roadmap item, not part of the current pipeline.

## Document Directory

1. [System Architecture and Probot Framework](01-architecture-and-probot.md)
   Core event loop, webhook handling, review memory across commits, privileged command gating, sandbox verification, Octokit REST and GraphQL integration, and GitHub CLI workflow integration.

2. [Model Orchestration and Vertex AI ADC](02-model-orchestration-and-vertex-adc.md)
   Application Default Credentials (ADC) setup, multi-tier routing (Flash + High Thinking for triage and deep review, antigravity-preview-05-2026 for experimental sandbox verification), token budgeting, and the Tier 1 and Tier 2 JSON schemas.

3. [Codebase Ingestion and Context Pipeline](03-codebase-ingestion-and-context.md)
   The active incremental PR diff pipeline, heuristic filters, review memory, and the planned whole-repository ingestion and AST indexing roadmap.

4. [GitHub App Lifecycle, Permissions, and Security](04-github-app-lifecycle-and-security.md)
   Manifest-driven registration, granular permissions (`checks: write`, `pull_requests: write`, `contents: write`, `issues: write`, `metadata: read`), authentication mechanics, credential redaction boundaries, RBAC enforcement, and repository isolation.

5. [Deployment and Operations](05-deployment-and-operations.md)
   The reference GHCR + Docker Compose deployment with a 15-minute update timer, Cloud Run as an alternative, the npm CLI vs App daemon, local development with Smee.io, the full environment variable reference, health checks, backup and rollback, and rate-limit mitigation.
