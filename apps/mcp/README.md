# Peridot MCP Canister (Phase 2 — ANT-830: Mintlify-sourced index)

Rust ICP canister exposing **four read-only MCP tools** over
**Streamable HTTP (MCP 2025-11-25, JSON response mode, stateless)** at
`POST /mcp`: `search_docs`, `get_integration_guide`, `get_example`,
`get_sdk_reference`.

Parent research: ANT-841 (handoff — update-call-only `/mcp`, no
`ic-http-certification` tree for the dynamic endpoint). Phase 1 build:
ANT-845 (4-tool surface over baked stub datasets, PR #154). Phase 2
(ANT-850, this change): the stub datasets are replaced by a committed
generated index built offline from the in-repo Mintlify tree
(`apps/docs/`); every tool response carries additive `source: {url, rev}`
attribution. Frozen limits, protocol version, and tool names are unchanged.

## Docs sync pipeline (Phase 2)

The canister serves a **committed generated artifact** — no network fetch,
no HTTPS outcalls, no timers on the request path (statically checked, see
`docs/sync-notes.md`).

```bash
# from apps/mcp/
./scripts/sync-docs          # regenerate src/generated_docs.rs + src/generated_docs.meta.json
./scripts/sync-docs --check  # fail loudly on drift (CI runs this)
cargo test -p peridot_mcp    # 55 tests, must be green
```

Inputs: `apps/docs/*.mdx` (12 guides) + `apps/docs/api/overview.mdx` +
`apps/docs/openapi.yaml` + `apps/docs/docs.json` (canonical slug list).
Output: `src/generated_docs.rs` (175 search entries + 15 guides +
8 verbatim examples + 3 SDK modules, ~96 KiB; budget ≤ 160 KiB) plus
`src/generated_docs.meta.json` (`sourceSha`, `contentHash`, `entryCounts`,
`builtAt`). Regeneration is deterministic and byte-identical; `--check`
compares the `.rs` bytes plus the meta hash/counts (only `builtAt` differs).

Design decision (spec open question 1): **generated Rust module**, not
JSON + `include_str!` — zero runtime parse cost, smaller wasm (no JSON
parser on the hot path), and the Rust compiler type-checks the index
shape. OpenAPI `operationId`s do not exist in `openapi.yaml` today, so
`openapi.yaml` feeds `search_docs` only (spec open question 3);
`get_sdk_reference` is grounded in `sdk.mdx`. Frozen `payments`/`wallet`
topics resolve as documented aliases (`fiat`, `embed-wallet` — spec open
question 2: `docs.json` has no such slugs).

## Layout

```text
apps/mcp/
├── Cargo.toml          # cdylib crate `peridot_mcp` (ic-cdk 0.20.3, ic-http-certification 4.0.1)
├── dfx.json            # standalone canister `peridot_mcp` (see "dfx.json placement" below)
├── docs/
│   ├── sync-notes.md   # baked-index contract + future sync-job rules
│   └── topup-runbook.md# cycles monitor + top-up draft (no mainnet funding yet)
├── src/
│   ├── lib.rs          # query/update entry points, http_request dispatch
│   ├── protocol.rs     # JSON-RPC + MCP types/dispatch (pure, unit-tested)
│   ├── tools.rs        # 4 baked read-only datasets (pure, unit-tested)
│   ├── http.rs         # candid HTTP types, routing, header contract, certification
│   └── peridot_mcp.did # committed candid; CI-guarded by did_consistency_tests
├── tests/mcp_tests.rs  # handshake + 4-tool end-to-end dispatcher tests
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
cargo test -p peridot_mcp            # 49 tests, must be green

dfx start --background               # local replica + HTTP gateway
rustup target add wasm32-unknown-unknown
dfx deploy                           # builds the wasm, installs peridot_mcp
dfx canister id peridot_mcp          # <canister-id> for the URL below

# smoke test through the gateway (initialize -> notifications -> list -> call):
GW=http://uxrrr-q7777-77774-qaaaq-cai.localhost:4943
curl -s -X POST $GW/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"opencode","version":"1.0.0"}}}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST $GW/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'   # expect 202
curl -s -X POST $GW/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'  # 4 tools
curl -s -X POST $GW/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_integration_guide","arguments":{"topic":"wallet"}}}'
curl -s -X POST $GW/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"ping"}'                 # expect {"result":{}}

# certification check: the query path carries v2 certification headers that
# the gateway verifies (a cert-disabled build gets a 503 "response
# verification error" instead of the 405 below).
curl -s -D - -o /dev/null $GW/mcp | grep -i '^IC-Certificate'
# NOTE: POST /mcp content is served through update calls, which are
# consensus-certified at the protocol layer (replicas sign, gateway verifies
# during update polling) and carry no IC-Certificate response headers.
# The GET check above proves the canister's tree certification end to end.
```

## OpenCode client config

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

## Certification design (ANT-841 recommended path)

- `POST /mcp` content is served through **`http_request_update`**. Update
  calls are consensus-certified by the protocol (replicas sign, gateway
  verifies against the state-tree certificate). No `ic-http-certification`
  tree is built for dynamic JSON-RPC (ANT-841: open-ended params/ids have no
  finite pre-image, so per-response witnesses are infeasible).
- The `http_request` query path never serves content: `POST /mcp` returns
  `upgrade: true` (gateway re-issues as update); deterministic `405`/`404`
  responses are response-only tree-certified via `ic-http-certification`
  (`init` + `post_upgrade` install the root hash; the query handler attaches
  the v2 `IC-Certificate` header when the gateway supplies a certificate).
  `OPTIONS /mcp` returns a plain CORS preflight (no content, browsers do not
  verify certificates).

## Contract notes (ANT-845)

- `tools/list` returns exactly
  `[get_example, get_integration_guide, get_sdk_reference, search_docs]`
  (lexicographic order), each with `title`, `description`, `inputSchema`.
  `nextCursor` is omitted (single page).
- `initialize` negotiates `2025-11-25` (accepts `2025-03-26`/`2025-06-18`),
  returns `capabilities: {"tools": {}}` + `serverInfo`. Never require
  `2026-07-28` (breaks current SDKs).
- `notifications/*` (incl. `notifications/initialized`) → **202**, empty body.
- `ping` → `{"result": {}}`.
- `tools/call`: unknown tool → `-32602` + `data.tool`; tool-level miss
  (unknown topic/name/module/symbol) → success with `isError: true` (never a
  protocol error); no-match `search_docs` stays success without `isError`.
- Transport headers: `Content-Type: application/json` required (400);
  `Accept` honored — JSON-only yields the single JSON object this server
  always returns; a present `Accept` naming no supported representation is
  406; unsupported `MCP-Protocol-Version` is 400. `Mcp-Session-Id` is ignored
  on input and never emitted. Every update response carries
  `Content-Type: application/json`.
- `OPTIONS /mcp` → 204 + CORS headers. `GET /mcp` → 405. `/.well-known/ic-domains` → 200 `text/plain` (`mcp.peridot.id`, tree-certified, for custom-domain ownership). Other paths → 404.
- Limits: request ≤ 64 KB (else 413 + `-32602`), response ≤ 32 KB
  (search lists truncate with `"truncated": true`), string args ≤ 500 chars
  (chars, not bytes). Stateless: no batch, no sessions.
- Cycles: see `docs/topup-runbook.md`. Sync rules: see `docs/sync-notes.md`.

## Non-goals (do NOT add in Phase 1)

No Mintlify sync job, no `llms.txt` ingestion, no mainnet deploy or cycles
deposit, no custom domain cutover (Trevor preps `mcp.peridot.id`
separately), no auth/sessions, no SSE streaming, no timers, no per-request
HTTPS outcalls.

## Troubleshooting

- `dfx deploy` fails with candid mismatch: run `cargo test -p peridot_mcp`
  and read `did_consistency_tests` output; copy `__export_service()` output
  into `src/peridot_mcp.did` verbatim.
- Gateway returns upgrade loops: the query `http_request` must return
  `upgrade: true` with an empty body for `POST /mcp`; content is only served
  from `http_request_update`.
- Missing `IC-Certificate` on direct `dfx canister call`: expected — there is
  no gateway data certificate on direct calls; check via the gateway URL.
- `415/400` on POST: the canister requires `Content-Type: application/json`
  (see "Transport headers" above); MCP clients already send it.
