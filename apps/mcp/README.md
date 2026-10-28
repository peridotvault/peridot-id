# Peridot MCP Canister (Phase 1 — ANT-842/ANT-843)

Minimal Rust ICP canister exposing **one MCP tool** (`search_docs`) over
**Streamable HTTP (JSON response mode, stateless)** at `POST /mcp`.

Parent spec: ANT-842 (full Phase 1 spec lives in the ANT-842 task comment).
Implementation task: ANT-843. QA validation: ANT-844 (Tristan).

## Layout

```text
apps/mcp/
├── Cargo.toml          # cdylib crate `peridot_mcp` (ic-cdk 0.20.3, ic-http-certification 4.0.1)
├── dfx.json            # standalone canister `peridot_mcp` (see "dfx.json placement" below)
├── src/
│   ├── lib.rs          # query/update entry points, http_request dispatch
│   ├── protocol.rs     # JSON-RPC + MCP types/dispatch (pure, unit-tested)
│   ├── tools.rs        # search_docs stub + 3-doc dataset (pure, unit-tested)
│   ├── http.rs         # candid HTTP types, routing, certification wiring
│   └── peridot_mcp.did # committed candid; CI-guarded by did_consistency_tests
├── tests/mcp_tests.rs  # AC1/AC2/AC4/AC6 end-to-end dispatcher tests
└── README.md
```

`dfx.json` placement: the repo has no root `dfx.json` and `apps/*` are
independent Node apps, so `apps/mcp/dfx.json` is standalone. Revisit if a
repo-wide `dfx.json` appears (Phase 3+).

## Prerequisites

- Rust 1.99.1 (verified); MSRV ≥ 1.88 per the ic-cdk 0.20 line.
  `rustup target add wasm32-unknown-unknown` for canister builds.
- `dfx` 0.29+ for the local replica loop.

## Local dev / test loop

```bash
# from apps/mcp/
cargo test -p peridot_mcp            # 31 tests, must be green (AC7)

dfx start --background               # local replica + HTTP gateway
dfx deploy                           # builds the wasm, installs peridot_mcp
dfx canister id peridot_mcp          # <canister-id> for the URL below

# smoke test through the gateway (AC1 + AC2 + happy-path call):
GW=http://<canister-id>.localhost:4943
curl -s -X POST $GW/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"opencode","version":"1.0.0"}}}'
curl -s -X POST $GW/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
curl -s -X POST $GW/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"wallet"}}}'

# certification check (AC5, Tristan's remit):
curl -sI -X POST $GW/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}' | grep -i '^IC-Certificate'
```

## OpenCode client config (NFR5 minimum client)

```json
{
  "mcp": {
    "peridot-id": {
      "type": "streamable",
      "url": "http://<canister-id>.localhost:4943/mcp"
    }
  }
}
```

Replace `<canister-id>` with `dfx canister id peridot_mcp`. OpenCode must
complete initialize → tools/list → tools/call against this URL.

## Certification design (FR7 default)

- `POST /mcp` content is served through **`http_request_update`**. Update
  calls are consensus-certified by the protocol (replicas sign, gateway
  verifies against the state-tree certificate).
- The `http_request` query path never serves content: `POST /mcp` returns
  `upgrade: true` (gateway re-issues as update); deterministic `405`/`404`
  responses are response-only tree-certified via `ic-http-certification`
  (`init` + `post_upgrade` install the root hash; the query handler attaches
  the v2 `IC-Certificate` header when the gateway supplies a certificate).
- Adopt the ANT-841 (Andrew) handoff when posted if it changes this default.

## Contract notes (frozen for Phase 2)

- `tools/list` returns exactly `[search_docs]`, lexicographic order.
- No-match `tools/call` is success with
  `{"results":[],"resultCount":0,"message":"No PeridotID documentation matches '<query>'."}`
  (`isError` absent) — never fabricate an answer.
- Limits: request ≤ 64 KB (else 413 + `-32602`), response ≤ 32 KB
  (truncated with `"truncated": true`), `query` ≤ 500 chars (chars, not bytes).
- Stateless: `Mcp-Session-Id` is ignored. No batch. `GET /mcp` → 405.

## Non-goals (AC8 absence — do NOT add in Phase 1)

No Mintlify sync, no `llms.txt` ingestion, no mainnet deploy, no custom
domain, no auth/sessions, no SSE streaming, no timers, no HTTPS outcalls.

## Troubleshooting

- `dfx deploy` fails with candid mismatch: run `cargo test -p peridot_mcp`
  and read `did_consistency_tests` output; copy `__export_service()` output
  into `src/peridot_mcp.did` verbatim.
- Gateway returns upgrade loops: the query `http_request` must return
  `upgrade: true` with an empty body for `POST /mcp`; content is only served
  from `http_request_update`.
- Missing `IC-Certificate` on direct `dfx canister call`: expected — there is
  no gateway data certificate on direct calls; check via the gateway URL.
