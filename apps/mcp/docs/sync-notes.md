# Docs sync notes (ANT-845) — baked index contract

## Current state (Phase 1)

All four tool datasets live in `src/tools.rs` as hardcoded `&'static`
constants compiled into the canister (`DOCS`, `GUIDES`, `EXAMPLES`,
`SDK_DOCS`). There is **no per-request HTTPS outcall** in the canister —
verify with:

```bash
# from apps/mcp/ — must print nothing
grep -rn "http_request_outcall\|management_canister\|fetch(" src/ || true
grep -rn "set_timer\|set_timer_interval" src/ || true
```

Updating content = editing `tools.rs` (+ tests) and redeploying. This is
intentional for Phase 1: the corpus is tiny (< 10 KB) and changes rarely.

## Future sync-job contract (not implemented)

When a Mintlify/`llms.txt` sync job is built (Phase 2+), it MUST:

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
