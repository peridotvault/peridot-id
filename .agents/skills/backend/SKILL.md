---
name: backend
description: Apply Arctis Architecture when implementing, refactoring, or reviewing TypeScript backend code, especially Hono APIs. Keep domain ownership, transport, validation, business logic, and data access clear without assuming a fixed folder layout.
---

# Backend Architecture

Apply this skill to each backend application independently. Its principles are established; its directory layout is provisional.

1. Inspect the application's existing modules, framework conventions, dependency flow, and validation commands before editing.
2. Identify the owning domain or module. Keep HTTP routing and handlers lightweight; separate transport, validation, business logic, and data access according to the existing codebase. Read [structure](references/structure.md) before choosing files or directories.
3. Keep dependencies explicit. Avoid circular imports and unnecessary cross-module coupling. Centralize only genuinely reusable infrastructure. Read [boundaries](references/boundaries.md) for decision rules and Hono examples.
4. Validate external input at trust boundaries. Keep changes easy to audit and avoid abstractions without a concrete need.
5. Run available linting, type checking, and relevant tests. Report unresolved boundary or validation issues.

Do not present a particular backend directory tree as an approved Arctis standard. Preserve the application's established layout unless a change is justified by the task.
