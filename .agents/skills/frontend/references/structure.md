# Structure and ownership

## Mandatory application structure

Every frontend application has exactly three architectural directories directly under `src/`:

```text
src/
├── pages/
├── feat/
└── shared/
```

Minimal bootstrap or declaration files such as `main.tsx`, `vite-env.d.ts`, and platform entrypoints may sit directly under `src/`. Application logic belongs in the three directories. Do not add `src/components/`, `src/hooks/`, `src/utils/`, `src/lib/`, `src/services/`, `src/types/`, `src/store/`, or `src/styles/` as architectural roots. Do not add empty directories for visual symmetry.

## Pages compose

`pages/` contains only page components (`*.tsx`, including `index.tsx`) and `route.tsx` route configuration files, in route groups where useful. It owns page-level composition, not feature implementation. Pages may assemble `feat/` and `shared/` components and use external packages. Do not put hooks, utilities, services, schemas, stores, types, styles, or reusable components in `pages/`; do not add implementation directories there. A page may contain simple route-specific UI and rendering. Move complex state, network orchestration, and business behavior to the owning feature.

Prefer pages under about 150 lines and regular components under about 250 lines. These are review guidelines, not validator failures. Split cohesive code only when a meaningful component or responsibility emerges.

## Features implement

Each immediate child of `feat/` is one independent feature. Keep its implementation inside that boundary. Use only needed subdirectories from this vocabulary: `components/`, `hooks/`, `utils/`, `types/`, `styles/`, `services/`, `constants/`, `schemas/`, `context/`, and `store/`. Files may also live at the feature root. Do not create a barrel or wrapper for every directory by default.

```text
feat/
├── auth/
│   ├── components/LoginForm.tsx
│   ├── hooks/useLogin.ts
│   └── services/login.ts
└── dashboard/
    └── components/RevenueSection.tsx
```

## Shared provides primitives

`shared/` contains feature-independent UI primitives, hooks, utilities, types, styling, validation helpers, constants, and infrastructure. Its optional subdirectories use the same vocabulary as features. Keep modules small and cohesive; shared is not a home for arbitrary domain logic. Generic primitives may begin here before multiple features use them.

When independent features duplicate an implementation, identify its smallest reusable responsibility, verify that it has no feature ownership, move that part to `shared/`, update consumers, remove duplicates, and rerun boundary checks and tests. A component used by two **pages** can remain in its owning **feature**; page count alone does not justify promotion. Never move an entire business feature to `shared/` to bypass isolation.

## Common anti-patterns

- Business logic embedded in a page or a route file.
- A cross-feature dependency disguised by a barrel, alias, or type-only import.
- Feature-specific names or behavior in `shared/`.
- Empty folder trees, unnecessary service layers, trivial one-line hooks, and wrappers with no responsibility.
- Oversized modules with unrelated helpers or deeply nested directories that obscure ownership.

Read [routing](routing.md) for page groups and [boundaries](boundaries.md) for permitted dependency directions.
