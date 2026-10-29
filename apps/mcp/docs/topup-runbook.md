# Production deploy + cycles top-up runbook (Phase 4 — ANT-856, board-approved)

> Board approval: request_confirmation `83482765` on ANT-830, ACCEPTED by the
> board human 2026-10-29. Authorizes: (1) exactly **3T cycles** funding from
> the 20T budget (**17T stays in reserve**, no further funding without a new
> approval); (2) mainnet deploy of the paperclip-tip wasm; (3)
> `mcp.peridot.id` cutover; (4) production E2E. No dev/test/main promotion.

## 0. Build artifact under deploy (reproducible)

- Source tip: `origin/paperclip` @ `685d066` (Phase 1 `36fdf8e` + Phase 2
  `c1e5d3d` + Phase 3 `685d066`; QA PASS at every phase).
- Reproducible local build (verified 2026-10-29, Rust 1.99.1, dfx 0.29.2):

```bash
# from a fresh checkout of origin/paperclip
cd apps/mcp
cargo build --release --target wasm32-unknown-unknown
cargo test   # 45 unit + 11 integration, must be green
cargo check  # must be clean
```

- Verified evidence this run: wasm
  `apps/mcp/target/wasm32-unknown-unknown/release/peridot_mcp.wasm`,
  1,232,468 B,
  sha256 `11585917ab40d7f2052af68740371da3996585e1ea5b000bc01170cb3cf4dfb7`;
  `cargo test` 45 + 11 green; `cargo check` clean.
  (Size differs slightly from the Phase 3 report's 1,184,289 B — toolchain
  profile delta, no source change; `sync-docs --check` is the drift gate.)
- Preconditions before any deploy: `cargo test` green,
  `./scripts/sync-docs --check` green, wasm sha256 recorded in the deploy
  comment.

## 1. Production canister (record on deploy)

| Field | Value |
| ----- | ----- |
| Canister ID | _TBD — fill at creation_ |
| Subnet | standard low-cost application subnet (record subnet ID at creation) |
| Initial funding | exactly **3T cycles** (17T reserve untouched) |
| Freezing threshold | set per measured idle burn (~25M cycles/day); record value |
| Controllers | least-privilege: deploy operator identity + recovery controller only, no wildcards |
| Wasm | paperclip-tip build above, sha256 recorded |

```bash
# create on a low-cost app subnet (operator runs; names only, no secrets here)
dfx canister --network ic create peridot_mcp --subnet-type application --with-cycles 3000000000000
dfx canister --network ic status peridot_mcp   # record ID, subnet, balance, threshold
dfx deploy --network ic --no-wallet            # installs the paperclip-tip wasm
dfx canister --network ic status peridot_mcp   # confirm module hash = built wasm
```

Blast radius: a fresh canister — failure affects only this deploy, never
existing mainnet state. No migration (stateless canister, no stable memory).

## 2. Custom domain cutover (`mcp.peridot.id` → production canister)

Pre-cutover state (verified 2026-10-29): `mcp.peridot.id` has **no**
A/AAAA/CNAME and no `_canister-id` TXT; parent `peridot.id` is on Cloudflare;
`curl https://mcp.peridot.id/mcp` returns `000` (no route). Correct — nothing
to tear down.

Staged plan (execute ANT-846 domain scope under this approval):

1. Stage DNS records (low TTL first, e.g. 60–300s) + `_canister-id`
   `<canister-id>` TXT; verify with `dig`.
2. Smoke-test window through the custom domain **before** the prod flip:
   `curl -i https://mcp.peridot.id/mcp` — HTTPS 200/202, correct MCP
   headers, JSON response mode; `GET /mcp` carries `IC-Certificate`.
3. Prod flip: point `mcp.peridot.id` at the production canister, raise TTL
   back to normal only after E2E passes.
4. Verify connectivity through the **custom domain**, not only the canister
   ID (QA scenarios 1, 2, 8 explicitly cover this).

```bash
dig +short mcp.peridot.id
dig +short TXT _canister-id.mcp.peridot.id
curl -i -X POST https://mcp.peridot.id/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

HTTP response certification: `POST /mcp` is served via `http_request_update`
(consensus-certified at the protocol layer; no `IC-Certificate` header on
update responses by design). Deterministic `GET /mcp` 405 / 404 responses are
tree-certified with `IC-Certificate` v2 headers — see README "Certification
design". Address explicitly in the cutover comment.

## 3. Upgrades

- Stateless canister: no stable memory, no timers, no sessions — upgrades
  carry no data.
- Upgrade = rebuild from the target `paperclip` tip (Section 0 steps) +
  `dfx canister --network ic install --mode upgrade`. Record old + new wasm
  sha256 in the comment. No per-request outcalls, no new tools, no contract
  changes without a new spec + QA gate.

## 4. Rollback (tested path before rollout)

- Code rollback: redeploy the **prior wasm** (keep prior wasm bytes +
  candid + sha256 from the deploy comment). Stateless, so `install --mode
  reinstall` of the prior wasm is safe (no state to wipe); prefer `upgrade`
  when the module path allows it.

```bash
# from apps/mcp/, operator runs
dfx canister --network ic install --mode reinstall peridot_mcp  # prior wasm, stateless-safe
dfx canister --network ic status peridot_mcp
```

- DNS rollback: revert `mcp.peridot.id` records to the pre-flip values
  recorded in the cutover comment. **Check TTL beforehand** — with a 60–300s
  staging TTL the revert propagates in minutes; with a raised production TTL
  it takes up to the TTL. Never raise TTL until E2E passes.
- MTTR target: code rollback < 15 min, DNS revert < TTL + 10 min. Both paths
  are documented here *before* launch (observability-before-launch).

## 5. Monitoring + alerting (lands with the change, not after)

```bash
# from apps/mcp/
dfx canister --network ic status peridot_mcp   # cycles balance, freezing threshold
```

- Track: cycles balance vs 3T start, burn/call vs Phase 3 baselines
  (~8.4M search, ~7.1M floor, idle ~25M/day); flag over-budget burn.
- Monthly burn guide: ~0.24T @1K calls/day, ~2.37T @10K/day, ~23.7T
  @100K/day — rate-limit/monitor story before raising traffic.
- Every alert links here (runbook hygiene: a stranger can follow this at 3am).

## 6. Top-up (reserve untouched)

- The 17T reserve is **not** touched by this runbook. Any top-up beyond the
  initial exactly-3T needs a **new board approval** — never auto-top-up.
- At alert thresholds, file the measured burn + requested amount as a new
  board request; on approval:

```bash
# operator runs with the cycles-wallet name on file (never paste secrets):
dfx canister --network ic deposit-cycles <APPROVED-AMOUNT> peridot_mcp
dfx canister --network ic status peridot_mcp
```

## 7. Discipline in code (unchanged, restated)

- Ingress caps: request bodies ≤ 64 KB (413 beyond), string args ≤ 500 chars,
  responses ≤ 32 KB (lists truncate). Keeps per-call instructions bounded.
- No timers, no per-request HTTPS outcalls, no inter-canister calls, no
  stable-memory growth: the request path is pure dispatch over baked data.

## 8. Measured baselines (Phase 3, for prod comparison)

| Call | Mean cycles/call |
| ---- | ---------------- |
| initialize | 7,380,059 |
| tools/list | 7,697,309 |
| tools/call search_docs | 11,083,767 |
| tools/call get_integration_guide | 7,502,373 |
| tools/call get_example | 7,378,357 |
| tools/call get_sdk_reference | 7,857,716 |
| ping (floor) | 7,071,395 |

Idle: 24,951,596 cycles/day. Wasm (Phase 3 build): 1,184,289 B; this-run
rebuild: 1,232,468 B, sha256 above. Artifact `generated_docs.rs`: 98,728 B.
