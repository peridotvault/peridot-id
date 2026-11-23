---
name: backend
description: Apply Arctis Backend Architecture when implementing, refactoring, or auditing TypeScript backend applications, especially Hono APIs. Enforce module ownership, api/schemas/services/repositories layering, dependency direction, validation at trust boundaries, and executable architecture checks.
---

# Arctis Backend Architecture

**Modules own features. Layers own responsibilities. Shared stays generic.** Apply this skill independently to each backend application, including apps in monorepos.

## Before coding

1. Read the target repository's `AGENTS.md`, backend documentation, existing import rules, and validation commands. Locate the application's `src/` and inspect its modules, shared infrastructure, database client, generated code, and tests.
2. Identify the owning module and classify new code as API transport, schema contract, service rule, or repository persistence. Do not invent a fifth layer or a module-root shortcut.
3. Read [structure](references/structure.md) for required placement; [boundaries](references/boundaries.md) for import rules; [routing](references/routing.md) for HTTP composition and error handling; [database](references/database.md) for Prisma and migration rules; [testing](references/testing.md) for test placement.

## During coding

- Put every feature in `src/modules/<name>/` with `api/`, `schemas/`, `services/`, and `repositories/`. Keep HTTP route registration, Zod validation, business rules, and Prisma queries in their own layers.
- Keep dependencies flowing `api → schemas/services → repositories → db/generated`. Never import another module, never let `shared/` import a module, and never bypass a layer with aliases, type-only imports, re-exports, dynamic imports, or `require`.
- Validate untrusted input at its trust boundary. Map domain errors to the shared HTTP error envelope; do not expose database errors or secrets.
- Keep generated Prisma output out of source edits and Git. Use reviewed migrations, never `db push` on shared databases, and never reset a database containing data without explicit approval.
- Do not create empty folders, duplicate root files inside a module, or generic wrappers without a current caller. Keep `*.test.*` and `*.spec.*` files out of `src/`; tests belong in the application's `tests/` tree.

## Before completion

Run the [architecture validator](references/enforcement.md), the application's lint, type-check, build, and relevant tests. Review module ownership, layer direction, route thinness, validation at boundaries, and safe migration handling. Do not silently disable, suppress, or weaken checks. Report commands run, unresolved violations, and validation limits. If a request conflicts with these rules, explain the conflict and implement a compliant path where possible.
