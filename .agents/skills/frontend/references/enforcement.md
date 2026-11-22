# Automated enforcement

Use the bundled validator for Arctis-specific file placement, resolved import boundaries, route exceptions, and cycles. Use the host application's ESLint configuration for code quality and TypeScript for type safety. Keep all three in CI. General layer rules can also be reflected in an architecture-aware ESLint plugin such as [`eslint-plugin-boundaries`](https://github.com/javierbrea/eslint-plugin-boundaries), but a broad `pages → pages` allowance would break Arctis's narrow route exception. The bundled validator is the authoritative check for that exception; do not disable it because ESLint passes.

## Runtime and installation

The validator requires Node.js 20 or newer and the skill's pinned TypeScript 5.9.3 dependency. The dependency is for validation only; it is not an application scaffold. Copy the **entire** `frontend/` skill directory into a [supported skill location](https://learn.chatgpt.com/docs/build-skills), then install its validator dependency once:

```sh
npm ci --prefix .agents/skills/frontend
node .agents/skills/frontend/scripts/validate-architecture.mjs .
```

The argument is the **frontend application root**, which must contain `src/` and may contain `tsconfig.json`. In a monorepo, run the validator separately for each frontend application, for example:

```sh
node .agents/skills/frontend/scripts/validate-architecture.mjs apps/app
node .agents/skills/frontend/scripts/validate-architecture.mjs apps/admin
```

The validator reads `compilerOptions.paths` and normal TypeScript resolution from that application's `tsconfig.json`; it compares canonical resolved file paths. Put aliases in the application's TypeScript configuration so they can be checked. Exit code `0` means no detected violations, `1` means architecture violations, and `2` means the validator could not run (for example, missing TypeScript or invalid configuration). Treat nonzero exits as CI failures. `WARN` lines describe checks that require review.

For Codex, the [official documentation](https://learn.chatgpt.com/docs/build-skills) confirms repository-level `.agents/skills/` and user-level `~/.agents/skills/` locations. Other agents may use different paths. A project `AGENTS.md` should explicitly request the skill and retain the essential constraints because automatic skill activation is not guaranteed.

## Checks performed

The validator checks:

- Required `src/pages/`, `src/feat/`, and `src/shared/` directories; no other direct `src/` directories or symlinked source paths.
- `pages/` file extensions, forbidden implementation directories, and `route.tsx` in every page group.
- Cross-feature, reverse-layer, page-to-page, and invalid route-registration imports, including aliases, relative paths, type-only imports, re-exports, barrels, static `require`, and literal dynamic imports.
- Circular imports across source files in `src/`.

Import targets are resolved with the TypeScript compiler API. A violation prints the source path, position when available, a stable error code, and a short explanation. For example, `CROSS_FEATURE` means one `feat/<name>/` imports a different feature; `INVALID_ROUTE_IMPORT` means a route file imports outside its own pages or immediate child routes. Fix ownership or composition rather than changing the import spelling.

## ESLint, type checks, tests, and CI

Keep the application's existing ESLint rules and run its configured lint command, TypeScript check, and relevant tests. `eslint-plugin-boundaries` can provide editor-time feedback for broad layer isolation; configure it against **resolved** modules and verify its plugin version and resolver behavior in the host project. Do not copy an untested generic plugin configuration that permits all page imports. The validator supplies the route-specific check and works even if no architecture ESLint plugin is installed.

A CI job for a repository with project-installed skills can run, in order:

```sh
npm ci --prefix .agents/skills/frontend
node .agents/skills/frontend/scripts/validate-architecture.mjs apps/app
# Then run the application's configured lint, typecheck, and test commands.
```

Run the skill's own fixture suite after modifying its validator:

```sh
npm ci --prefix skills/architecture/frontend
npm test --prefix skills/architecture/frontend
```

The fixture suite covers allowed and forbidden edges, route ownership, aliases, type-only imports, re-exports, static dynamic imports, cycles, and layout failures. See [`tests/validate-architecture.test.mjs`](../tests/validate-architecture.test.mjs).

## Limits requiring review

- A dynamic import whose target is computed at runtime cannot be resolved statically. The validator emits a warning; inspect it and avoid using it to evade boundaries.
- TypeScript resolution is authoritative for configured aliases. Tool-specific aliases unknown to `tsconfig.json`, virtual modules, generated code, and non-TypeScript asset imports may need matching project configuration or separate checks.
- The validator does not prove that a `route.tsx` actually registers every page, or that an imported page is used **only** for registration. Review the route tree and integration tests.
- It cannot judge whether a page is thin, a component has one responsibility, a module is genuinely feature-independent, a directory is needlessly nested, or a root file is only bootstrap code. Review these semantically. The approximate 150/250 line guidance is not a machine failure.
- This validator inspects static imports in JavaScript and TypeScript source under `src/`. Framework transforms, runtime module loading, and code generated after validation require project-specific coverage.

Do not claim complete enforcement beyond this scope. Do not weaken or suppress checks to make a violation disappear; report unresolved cases.
