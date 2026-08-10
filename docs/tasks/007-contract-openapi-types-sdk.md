# 007 — Contract: OpenAPI + Types + SDK Wallet Support

## Status

done

## Objective

Expose the wallet API from task 006 through the project's existing contract layers.

## Why

PRD §10: follow the repository — `packages/openapi/src/openapi.yaml` is the API source of
truth, `@peridot/types` carries shared DTOs, `@peridot/sdk-js` is a thin fetch client with one
class per domain (`PeridotAuth`, `PeridotIdentity`, `PeridotProfile`). Wallet gets the same
treatment; nothing more.

## PRD References

- §10 — API/SDK
- §16 — Engineering (API/SDK changes follow existing conventions)

## Repository Context

- `packages/openapi/src/openapi.yaml` (486 lines; served at `GET /v1/openapi.yaml` via
  `apps/api/src/openapi/`).
- `packages/types/src/index.ts` — plain interfaces, one per DTO.
- `packages/sdk-js/src/index.ts` — `PeridotClient` aggregates domain classes; cookies via
  `credentials: "include"`; 401 handling with the no-recursion guard on `/v1/auth/*`.
- `docs/API_SPEC.md` and `docs/SDK_SPEC.md` are short endpoint/usage lists — update them (or
  defer to task 009; keep this task code-only).

## Scope

1. `openapi.yaml`: add the wallet endpoints implemented in 006 (schemas, 401/404 responses,
   cookie auth) following the existing file's style.
2. `@peridot/types`: add the wallet DTO type(s) matching the OpenAPI schema.
3. `@peridot/sdk-js`: add `PeridotWallet` (e.g. `me()`, plus creation method if 006 exposed
   one) and wire it into `PeridotClient`.

## Out of Scope

- New SDK abstractions, retry logic, or framework adapters (PRD §15: no speculative
  abstraction).
- Docs-site content (task 009).

## Dependencies

- 006 (endpoints must exist and be stable).

## Acceptance Criteria

- OpenAPI spec validates and matches the implemented routes exactly (the API serves this spec,
  so drift is user-visible).
- SDK wallet calls succeed against a locally running API using cookie auth (smoke test or
  script-level check; `apps/api/scripts/smoke.cjs` is the existing pattern to extend if
  practical).
- `pnpm build` / `pnpm typecheck` pass across the monorepo.
- No new dependencies added to any package.

## Testing Requirements

- Typecheck across packages; manual or scripted round-trip of the SDK methods against the dev
  API.

## Security Considerations

- Types must not include any sensitive wallet material field — the contract should make the
  §9 exposure rule structurally impossible to violate accidentally.
