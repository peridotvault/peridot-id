# Testing and delivery

## Test placement

Tests live outside `src/`. Application source under `src/pages/`, `src/feat/`, and `src/shared/` must not contain `*.test.*` or `*.spec.*` files.

```text
apps/web/
├── src/
│   ├── pages/
│   ├── feat/
│   └── shared/
└── tests/
    ├── unit/   # component, hook, and utility tests
    └── e2e/    # Playwright or equivalent browser tests
```

Keep unit tests under `tests/unit/` and browser tests under `tests/e2e/` (or the application's documented equivalent). Do not invent a parallel test tree inside `src/`; the architecture validator rejects it.

## Test responsibilities

- Unit tests cover feature logic, hooks, pure utilities, and view-model mapping without a browser.
- E2E tests cover real user flows through the router and rendered UI.
- Shared primitives may have their own unit tests under `tests/unit/`.
- Import source code from tests through the application's configured alias, for example `@/feat/auth/hooks/useLogin`.

## Completion checklist

- Architecture validator passes for the frontend app.
- ESLint, TypeScript check, build, and relevant tests pass.
- No test or spec file exists under `src/`.
- Route ownership and feature boundaries still pass review after test additions.
- Report any command that could not run and any unresolved violation. Never claim a check passed without its output.
