# Cycles benchmark + optimization + burn report (ANT-853, Phase 3)

Phase 2 tree: `paperclip` merge `c1e5d3d` (PR #155). Optimization branch:
`pc/peridotid-cycles-burn` (this report + one `src/tools.rs` change, no
wire-contract change). No mainnet, no cycles deposit, no domain cutover
(Phase 4, board-gated).

## 1. Method (so anyone can reproduce)

- Local replica: `dfx 0.29.2` (`dfx ping` healthy), canister
  `uzt4z-lp777-77774-qaabq-cai`, `dfx deploy` from the measured commit.
- Per-call cost: `dfx canister status` balance before/after **20 sequential
  `POST /mcp` update calls** per tool through the gateway
  (`Accept: application/json, text/event-stream`, `Content-Type:
  application/json`); `mean = delta/20`. Wall time per call recorded with
  `date +%s%N` around each `curl`.
- Idle burn + memory: `dfx canister status` (`Idle cycles burned per day`,
  `Memory Size`) on a fresh deploy with no traffic.
- Host attribution: release micro-benchmark of `search_docs`
  (16,000 calls, 8-query rotation) before/after the change.
- Response sizes: `protocol::handle_post` envelope bytes (host) and gateway
  body bytes (replica) — identical.

## 2. Raw numbers (baseline `c1e5d3d`, 20 iterations each)

| Tool / call | Mean cycles/call | Wall ms (min–max of 20) | Resp bytes |
| --- | --- | --- | --- |
| `initialize` | 7,380,059 | 1221–1254 | 148 |
| `tools/list` | 7,697,309 | 1219–1282 | 1390 |
| `tools/call search_docs` (query `wallet`) | 11,083,767 | 1221–1257 | 1662 |
| `tools/call get_integration_guide` (topic `wallet`) | 7,502,373 | 1221–1258 | 1820 |
| `tools/call get_example` (`passkey-login`) | 7,378,357 | 1213–1254 | 609 |
| `tools/call get_sdk_reference` (module) | 7,857,716 | 1223–1281 | 1992 |
| `tools/call get_sdk_reference` (module+symbol) | 7,471,477 | 1222–1253 | 442 |
| `ping` | 7,071,395 | 1222–1259 | 36 |

Balance-delta evidence (before → after, 20 calls):

```text
init:        2988019313431 → 2987871712235  delta=147601196  mean=7380059
list:        2987870396235 → 2987716450047  delta=153946188  mean=7697309
search_docs: 2987715134047 → 2987493458696  delta=221675351  mean=11083767
guide:       2987492142696 → 2987342095223  delta=150047473  mean=7502373
example:     2987280955686 → 2987133388546  delta=147567140  mean=7378357
sdk:         2987132072546 → 2986974918222  delta=157154324  mean=7857716
sdk_sym:     2986973602222 → 2986824172672  delta=149429550  mean=7471477
ping:        2986822856672 → 2986681428770  delta=141427902  mean=7071395
```

Reading: the update-call floor is ~7.1M (`ping`, empty result) — ingress +
consensus + certification. Only `search_docs` rises materially above it
(+3.6M: ranking + serializing 5 hits over the 175-entry corpus).

- p95 wall: all 160 timed calls fall in 1213–1282 ms ⇒ **p95 ≈ 1.26 s ≤
  1500 ms** holds. Wall time is gateway update-polling dominated, not
  execution (host execution is µs–ms; see §4).
- Idle burn (baseline, fresh deploy, no traffic): **24,951,596 cycles/day**,
  memory 2,441,635 B.
- Storage: `src/generated_docs.rs` 98,728 B; wasm
  `target/wasm32-unknown-unknown/release/peridot_id_mcp.wasm` **1,184,289 B**
  (+77,001 B vs Phase 1, per ticket baseline).

## 3. Optimization applied (one, measured — no churn)

**Cached lowercase corpus for `search_docs` ranking** (`src/tools.rs`,
`pc/peridotid-cycles-burn`): the ranker lowercased all 175 titles+excerpts
on every call (350 allocations + Unicode case-mapping per search). A
`static OnceLock<Vec<(String, String)>>` computes them once; the query path
compares against the cache with byte-identical ranking semantics.

- Wire contract: unchanged. Response bytes identical (table in §4); new unit
  test `cached_rank_matches_generic_rank` asserts `search_docs(q) ==
  rank(q, &DOCS)` over 13 probes; full suite green (45 unit + 11
  integration).
- Host payoff: `search_docs` 93.2 µs → **25.4 µs/call (−73%)**, 16,000-call
  rotation, release build.
- Replica payoff (20 iterations, same method as §2):

```text
search_docs (optimized): delta_20=167926539  mean=8396326   (−2,687,441/call, −24.2%)
guide (control, untouched): mean=7501337 (was 7502373 — unchanged, no replica drift)
```

- Cost of the change (tradeoff, stated plainly): wasm 1,184,289 →
  **1,232,468 B (+48,179 B, +4.1%** — `std` sync machinery; still inside the
  ≤+250 KiB-vs-Phase-1 budget: +125,180 B total); heap +~0.1–0.2 MB
  (memory 2,441,635 → ~2.56–2.62 MB); idle burn 24.95M →
  **~26.1–26.8M cycles/day (+~1.2–1.8M/day**, ±replica ingress noise).
- Breakeven: **>1 search call/day** (saves 2.69M per search vs ~1.5M/day
  extra idle). At 1K searches/day the cache saves ~2.7B/day for ~1.5M/day —
  net win by ~1800×. No other tool had compute above noise, so nothing else
  was touched (compact index + response caps were already frozen).

What was deliberately NOT changed: `serde_json` `preserve_order`, response
envelope order, ranking order, caps, tool names/schemas — all frozen; the
marginal gain did not justify wire-visible churn.

## 4. Post-optimization per-call costs (blended rate for burn math)

| Tool | Mean cycles/call (optimized) |
| --- | --- |
| search_docs | 8,396,326 |
| get_integration_guide | ~7.50M (unchanged) |
| get_example | ~7.38M (unchanged) |
| get_sdk_reference | ~7.5–7.9M (unchanged) |
| list / initialize / ping | ~7.1–7.7M (unchanged) |

Blended planning rate (assumed mix: 40% search, 20% guide, 20% example,
20% sdk — adjust with real traffic): **≈ 7.9M cycles/call**.

## 5. Monthly burn at 3 usage levels (blended 7.9M/call + idle ~26M/day)

| Traffic | Call burn/month | Idle/month | Total/month | vs 20T budget |
| --- | --- | --- | --- | --- |
| 1K calls/day | 0.24T | 0.0008T | **~0.24T** | 1.2% |
| 10K calls/day | 2.37T | 0.0008T | **~2.37T** | 12% |
| 100K calls/day | 23.7T | 0.0008T | **~23.7T** | **119% — exceeds budget** |

Idle is negligible at every level (0.78B/month). Storage check: at
$5/GB/year (≈3,760 cycles/byte/year), the ~2.6 MB footprint costs
≈ 9.8B cycles/year ≈ 27M/day — matches the replica's idle figure, so the
idle burn IS the storage cost; no separate storage line item is needed.

## 6. Initial-allocation recommendation (out of 20T, per ANT-841 strategy)

- **Deposit 3T initial, hold 17T in reserve.** 3T covers 10K calls/day for
  ~5 weeks (2.37T/month) with headroom for traffic spikes and reinstalls.
- **Top-up trigger: balance ≤ 1T** (~12 days of runway at 10K/day) —
  re-request from reserve, never auto-drawn.
- **100K/day is not fundable** from 20T without response caching or a
  query-path redesign (Phase 4 scope) — cap public traffic or revisit.
- Runbook pointer: `apps/mcp/docs/topup-runbook.md` (monitor + draft top-up;
  mainnet deposit stays board-gated).

## 7. QA handoff

Validate child: reproduce §2/§3 numbers on `pc/peridotid-cycles-burn`,
confirm this report's math, spot-check `tools/list` + 1 call/tool for
contract regression (expect byte-identical shapes to `c1e5d3d` except
`search_docs` latency/cycles, never content shape).
