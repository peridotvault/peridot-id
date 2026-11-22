---
name: monorepo
description: Coordinate architecture work across multiple frontend and backend applications in a monorepo. Use when a change spans apps, shared packages, or repository-wide architecture checks; apply the Arctis frontend and backend skills per application without imposing a monorepo tool or directory layout.
---

# Arctis Monorepo Architecture

Use this skill to coordinate work across applications. It defines no required package manager, build system, `apps/` layout, or cross-package dependency graph.

1. Read the repository's `AGENTS.md` and inspect workspace manifests, application entrypoints, package boundaries, and existing validation commands. Classify applications by their code, not by directory names such as `app`, `api`, `admin`, or `web`.
2. For each affected frontend application, use the `frontend` skill and apply its `pages/`, `feat/`, and `shared/` rules **within that application's own `src/`**. For each affected backend application, use the `backend` skill and its domain-boundary principles. If either required skill is unavailable, report that and follow the repository's essential architecture instructions; do not claim the missing skill was loaded.
3. Identify the owner of shared contracts or packages before moving code across applications. Prefer explicit, stable interfaces and the repository's existing package conventions. Do not merge independent frontend feature boundaries across apps or invent a universal monorepo layout to resolve one change.
4. Keep changes scoped to the affected applications and packages. Preserve the existing build and dependency workflow unless the task calls for changing it.
5. Run each affected application's relevant lint, type-check, test, and architecture commands. Run the frontend architecture validator separately for each affected frontend application when available. Report commands run, unresolved violations, and checks that could not run.

For work confined to a single application, use its `frontend` or `backend` skill directly. This skill adds coordination, not a replacement architecture for either application type.
