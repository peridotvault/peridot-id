# Cycles top-up runbook (DRAFT — ANT-845, local/testnet only)

> No mainnet funding from this issue. Production cutover (cycles deposit,
> freezing threshold, custom domain) needs a future board confirmation —
> this runbook is the draft that confirmation will execute against.

## Discipline in code

- Ingress caps: request bodies ≤ 64 KB (413 beyond), string args ≤ 500 chars,
  responses ≤ 32 KB (lists truncate). Keeps per-call instructions bounded.
- No timers, no per-request HTTPS outcalls, no inter-canister calls, no
  stable-memory growth: the request path is pure dispatch over baked data.

## Monitor (testnet, pre-mainnet)

```bash
# from apps/mcp/
dfx canister --network ic status peridot_mcp   # cycles balance, freezing threshold
```

Watch the balance across smoke-test runs; a small JSON-RPC update costs
~15–30 M cycles (~$0.00002–0.00004), so the testnet burn is negligible.
Record the observed per-call burn here before the mainnet request.

Observed per-call burn (fill in after testnet runs):

| Call | Cycles |
| ---- | ------ |
| initialize | _tbd_ |
| tools/list | _tbd_ |
| tools/call search_docs | _tbd_ |

## Top-up (draft — DO NOT RUN against mainnet without board confirmation)

```bash
# Top up from the cycles wallet (amount decided by the board request):
# dfx canister --network ic deposit-cycles <AMOUNT> peridot_mcp
```

## Board-ready mainnet request (template)

- Cycles amount: 2–3 T initial (17–18 T held in reserve), per ANT-841.
- Freezing threshold: TBD (propose with measured idle burn).
- Rollback plan: keep the previous wasm + candid; `dfx canister --network ic
  install --mode reinstall` is NOT the rollback (it wipes state) — Phase 1
  holds no state, so reinstall of the prior wasm is safe; state this
  explicitly in the request.
