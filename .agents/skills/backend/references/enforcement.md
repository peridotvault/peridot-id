# Automated enforcement

Use the bundled validator for Arctis-specific module layout, resolved import boundaries, cycles, and test placement. Keep the host application's lint, type-check, build, and tests alongside it. General rules can also be reflected in an architecture-aware ESLint plugin, but the bundled validator is authoritative for the Arctis layer matrix; do not disable it because ESLint passes.

## Runtime and installation

The validator requires Node.js 20 or newer and the skill's pinned TypeScript 5.9.3 dependency. The dependency is for validation only; it is not application scaffolding. Copy the **entire** `backend/` skill directory into a supported skill location, then install and run:

```sh
npm ci --prefix .agents/skills/backend
node .agents/skills/backend/scripts/validate-architecture.mjs apps/api
```

The argument is the **backend application root**, which must contain `src/`. Run it separately for each backend application in a monorepo. Exit code `0` means no detected violations, `1` means architecture violations, and `2` means the validator could not run (for example, missing TypeScript or invalid configuration). Treat nonzero exits as CI failures. `WARN` lines describe checks that require review.

## Checks performed

The validator checks:

- `src/modules/` exists and every module has `api/`, `schemas/`, `services/`, and `repositories/`.
- No implementation files sit at a module root.
- Required test directories exist, no `*.test.ts` sits directly in `tests/unit/`, and no `*.test.*` or `*.spec.*` file exists under `src/` (`TEST_IN_SRC`).
- Cross-module imports, reverse-layer imports, `modules → shared` reverse ownership, `shared → modules`, and direct `db` access from `api` or `services`.
- Imports through relative paths, aliases, `import type`, re-exports, barrels, literal dynamic imports, and static `require`.
- Circular imports across source files in `src/`, excluding generated output.
- Symlinked source paths and local imports that cannot be resolved.

Import targets are resolved with the TypeScript compiler API using the application's `tsconfig.json`, including NodeNext `.js` specifiers and configured aliases. A violation prints the source path, position when available, a stable error code, and a short explanation. Fix ownership or composition rather than changing the import spelling.

## Application checks

Keep the application's existing lint and type configuration. For the reference Hono monorepo, completion means:

```sh
node .agents/skills/backend/scripts/validate-architecture.mjs apps/api
pnpm lint
pnpm check-types
pnpm build
pnpm --filter api test
```

A CI job with project-installed skills can run the validator before the application's own quality commands. Do not add generated Prisma output to validation inputs or commit it.

Run the skill's own fixture suite after modifying its validator:

```sh
npm ci --prefix skills/architecture/backend
npm test --prefix skills/architecture/backend
```

The fixture suite covers allowed and forbidden edges, aliases, type-only imports, re-exports, dynamic imports, `require`, cycles, symlinks, missing layers, module root files, and test placement. See [`tests/validate-architecture.test.mjs`](../tests/validate-architecture.test.mjs).

## Limits requiring review

- A computed dynamic import cannot be resolved statically. The validator emits a warning; inspect it and do not use it to evade boundaries.
- TypeScript resolution is authoritative for configured aliases. Tool-specific aliases, virtual modules, generated code, and non-TypeScript asset imports may need matching project configuration or separate checks.
- The validator does not prove that a handler is thin, a service rule is correct, validation covers every trust boundary, a migration is safe, or secrets are absent from responses. Review those semantically.
- It inspects static imports in JavaScript and TypeScript source under `src/`. Runtime loading, framework transforms, and code generated after validation require project-specific coverage.
- Do not claim complete enforcement beyond this scope. Do not weaken or suppress checks to make a violation disappear; report unresolved cases.
