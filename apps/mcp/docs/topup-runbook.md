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
  `apps/mcp/target/wasm32-unknown-unknown/release/peridot_id_mcp.wasm`,
  1,232,468 B,
  sha256 `11585917ab40d7f2052af68740371da3996585e1ea5b000bc01170cb3cf4dfb7`;
  `cargo test` 45 + 11 green; `cargo check` clean.
  (Size differs slightly from the Phase 3 report's 1,184,289 B — toolchain
  profile delta, no source change; `sync-docs --check` is the drift gate.)
- **Superseded (2026-11-04):** the wasm running on mainnet is the CI build of
  `34a2b18`, module hash `0x559717bafdcd12f68f6bd173a71a5b6474d4eccef8c5566abfae7134698b00f2`
  (run `41321826763`, verified equal to the uploaded artifact). The hash above
  is the 2026-10-30 manual deploy only. Local rebuilds are **not**
  byte-reproducible (different toolchain); the CI artifact is the canonical
  artifact.
- Preconditions before any deploy: `cargo test` green,
  `./scripts/sync-docs --check` green, wasm sha256 recorded in the deploy
  comment.

## 1. Production canister (deployed 2026-10-29)

| Field | Value |
| ----- | ----- |
| Canister ID | `2qr4p-3qaaa-aaaap-an6qa-cai` |
| Subnet | `3hhby-wmtmw-umt4t-7ieyg-bbiig-xiylg-sblrt-voxgt-bqckd-a75bf-rqe` (application) |
| Initial funding | exactly **3T cycles**, minted by the Cycles Minting Canister on 2026-10-29 (`create_canister` memo) and transferred in — the 20T wallet was **not** drawn down |
| Freezing threshold | 2,592,000 s (30 days) → freezes at ~28B at the measured idle burn |
| Controllers | `s627w-…-lhp-iae` (operator), `53dvv-wqaaa-aaaap-ab6qq-cai` (cycles wallet, set by `create --with-cycles`), `yuyy5-…-nlfa-mqe` (CI principal) |
| Wasm | CI build of `34a2b18`, module hash `0x559717ba…` (see §0) |

```bash
# create on a low-cost app subnet (operator runs; names only, no secrets here)
dfx canister --network ic create peridot_id_mcp --subnet-type application --with-cycles 3000000000000
dfx canister --network ic status peridot_id_mcp   # record ID, subnet, balance, threshold
dfx deploy --network ic --no-wallet            # installs the paperclip-tip wasm
dfx canister --network ic status peridot_id_mcp   # confirm module hash = built wasm
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

- **CI:** `.github/workflows/mcp.yml` upgrades the canister on every push to
  `main` that touches `apps/mcp/**` or `apps/docs/**`. Gates: `cargo test -p
  peridot_id_mcp` + `./scripts/sync-docs --check` (a stale baked index would
  keep serving old guidance to agents). Each run uploads its wasm as a
  rollback artifact (30 days). Secret: `DFX_IDENTITY_PEM_B64` in the
  `production` environment — a dedicated CI principal added as controller.
  No top-up in CI (see §6).
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
dfx canister --network ic install --mode reinstall peridot_id_mcp  # prior wasm, stateless-safe
dfx canister --network ic status peridot_id_mcp
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
dfx canister --network ic status peridot_id_mcp   # cycles balance, freezing threshold
```

- Track: cycles balance vs 3T start, burn/call vs Phase 3 baselines
  (~8.4M search, ~7.1M floor, **idle 0.93B/day — mainnet-measured**, not the
  25M/day local-replica figure); flag over-budget burn.
- Monthly burn guide: ~0.24T @1K calls/day, ~2.37T @10K/day, ~23.7T
  @100K/day (+0.028T/month idle) — rate-limit/monitor story before raising
  traffic.
- Every alert links here (runbook hygiene: a stranger can follow this at 3am).

## 6. Top-up (reserve untouched)

- The 20T wallet (`53dvv-wqaaa-aaaap-ab6qq-cai`) is **not** touched by this
  runbook: the 3T was minted fresh from the CMC, so the reserve was still
  ~20.85T at the post-launch audit. Any top-up needs a **new board
  approval** — never auto-top-up.
- **Top-up record — 2026-11-04:** **10T** deposited from the wallet
  (`2,431,974,925,926` → `12,431,972,981,926` cycles), wallet now **10.847T**.
  Done on direct instruction from the operator (`ifal@pid` /
  `s627w-…-lhp-iae`), **not** through a board request — file the approval ID
  here if one is raised retrospectively.
- At alert thresholds, file the measured burn + requested amount as a new
  board request; on approval:

```bash
# operator runs with the cycles-wallet name on file (never paste secrets):
dfx canister --network ic deposit-cycles <APPROVED-AMOUNT> peridot_id_mcp
dfx canister --network ic status peridot_id_mcp
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

### Mainnet, post-launch (2026-11-04 audit)

| Measurement | Value |
| ----------- | ----- |
| Idle burn | **932,704,098 cycles/day** (37× the Phase 3 figure) |
| Wasm upgrade (install cost) | **6,239,192,510 cycles** per upgrade |
| Launch spike, 2026-10-29 11:07 → 2026-11-01 15:34 (3.19 d) | **558,393,296,912 cycles** ≈ 175B/day ≈ 22K call-equivalents/day — unexplained (likely prod E2E/retry loop); record the cause before the next spike |
| Steady state, 2026-11-01 → 11-04 (2.51 d) | 3,386,752,652 cycles ≈ **1.35B/day** (idle + light traffic) |
| Balance at audit | 2,431,980,757,926 cycles (+47.2B reserved) → **~5 years runway** at 1.35B/day |
| Top-up 2026-11-04 | **+10,000,000,000,000** → 12,431,972,981,926 cycles; wallet 10.847T → **~25 years runway** at 1.35B/day |

Denial-of-wallet: `/mcp` is public and unauthenticated, every `POST` is an
update call at ~7.9M cycles, and neither the canister nor the ICP gateway
rate-limits. 100 req/s ≈ 68T/day ≈ 3.4× the whole 20T budget. Before any
traffic push, add a rate limit at Cloudflare (`mcp.peridot.id` is already
proxied) rather than changing the canister.
