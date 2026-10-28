# Docs sync notes (ANT-850 Phase 2) — baked index contract

## Current state (Phase 2)

All four tool datasets live in the **committed generated module**
`src/generated_docs.rs` (175 search entries + 15 guides + 8 verbatim
examples + 3 SDK modules, ~96 KiB), emitted offline by
`scripts/sync-docs` from the in-repo Mintlify tree (`apps/docs/`).
`src/tools.rs` holds the domain types, frozen ranking, and lookups;
`src/generated_docs.meta.json` pins `sourceSha`, `contentHash`,
`entryCounts`, and `builtAt`.

There is **no per-request HTTPS outcall** in the canister — verify with:

```bash
# from apps/mcp/ — must print nothing
grep -rn "http_request_outcall\|management_canister" src/ || true
grep -rn "set_timer\|set_timer_interval" src/ || true
# Cargo.toml gains no HTTP-client dependency (check [dependencies] by eye).
```

Updating content = `./scripts/sync-docs` (+ tests) and redeploying.
`./scripts/sync-docs --check` runs in CI and fails on drift.

## Index-update story

- `contentHash` (sha256 over normalized extracted content) is stored in the
  generated header and `generated_docs.meta.json`. CI recomputes it;
  re-sync **only** on source change (no-op when unchanged).
- Upgrade: stateless canister → redeploy new wasm (no state migration
  exists by design). Rollback: redeploy previous wasm; the previous
  generated artifact stays in git history. Rollback AC: `dfx deploy` of the
  prior commit serves the prior `rev` in `source` fields (local smoke,
  never mainnet).
- budgets: generated artifact ≤ 160 KiB; wasm delta ≤ +250 KiB vs the
  Phase 1 `paperclip` build; per-hit caps enforced by unit tests
  (excerpt ≤ 500 chars, guide body ≤ 8 KiB, example code ≤ 8 KiB,
  ≤ 32 symbols/module; frozen `MAX_RESULTS=5`, `MAX_QUERY_CHARS=500`,
  response ≤ 32 KiB).

## Original Phase 1 notes (kept for history)

Phase 1 served hardcoded `&'static` constants in `src/tools.rs`
(`DOCS` 3 entries, `GUIDES` 3 topics, `EXAMPLES` 3 names, `SDK_DOCS`
3 modules). Updating content meant editing `tools.rs` (+ tests) and
redeploying — intentional while the corpus was tiny.

## Sync-job rules (standing contract, from ANT-841)

Any future Mintlify/`llms.txt` sync job MUST:

1. Run **outside** the request path (offline script or timer-driven updater,
   never per-request outcalls).
2. Use explicit small `max_response_bytes` on every HTTPS outcall (never the
   2 MB default — a full-size reservation can burn ~20 B cycles per call).
3. Prefer HTTPS-outcall **v2** pricing (pay-as-you-go, ~38.4 M base).
4. Store source URLs + headings + version/commit metadata alongside each
   entry so answers stay attributable.
5. Keep the baked-index shape (`title`, `url`, `body`/`excerpt`) so the
   `tools/call` payload contract does not change.

Budget note (ANT-841): even daily syncs cost < 1 T cycles/year at these
sizes; the request path stays at ~15–30 M cycles per update call.
