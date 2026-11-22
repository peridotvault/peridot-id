---
name: frontend
description: Apply Arctis Frontend Architecture when creating, refactoring, or auditing React, TypeScript, Vite, Tauri, or compatible frontend applications. Enforce pages/feat/shared ownership, hierarchical route registration, isolated features, and resolved dependency boundaries.
---

# Arctis Frontend Architecture

**Pages compose. Features implement. Shared provides reusable primitives.** Apply this skill independently to each frontend application, including apps in monorepos.

## Before coding

1. Read the target project's `AGENTS.md`; locate the application's `src/` and inspect its pages, features, shared modules, route groups, aliases, and validation commands.
2. Identify the owning feature and classify new code as page composition, feature implementation, or feature-independent shared code.
3. Read [structure](references/structure.md) for file placement and reuse; [routing](references/routing.md) for page or route changes; [boundaries](references/boundaries.md) for imports and feature coordination; [enforcement](references/enforcement.md) for audits or validation setup.

## During coding

- Keep `pages/`, `feat/`, and `shared/` as the only architectural directories directly under `src/`. Minimal entrypoints and declarations may sit beside them; application logic belongs inside them.
- Keep pages thin and route registration hierarchical. Never make one ordinary page depend on another.
- Keep each `feat/<name>/` isolated. Dependencies flow `pages → feat → shared`, with `pages → shared` also allowed. Do not create reverse, cross-feature, or circular dependencies through any import form.
- Promote only the smallest genuinely feature-independent responsibility to `shared/`. Avoid duplicate logic and abstractions without a purpose.

## Before completion

Run the [architecture validator](references/enforcement.md), project ESLint, TypeScript checks, and relevant tests when available. Review route ownership, thin pages, and shared ownership. Do not silently disable, suppress, or weaken checks. Report which commands ran, unresolved violations, and validation limits. If a request conflicts with these rules, explain the conflict and implement a compliant path where possible.
