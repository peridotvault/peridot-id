# PeridotID Stellar Phase-0 testnet experiments (ANT-551)

Experiment-only. Not audited, never mainnet. Parent handoff: ANT-546
(plan rev `437621e5-7078-49ed-8d27-8a679b4f7058`, Arthur-approved 2026-10-25).

## Dependency pin (binding gate §9.3 — RECORDED, verified 2026-10-26)

| Dependency | Pin | Evidence |
|---|---|---|
| `stellar-accounts` (OZ Smart Account) | `=0.8.0` | crates.io; commit `ddc327e`; structured digest `sha256(AuthDigestPreimage { account, signature_payload, context_rule_ids })` |
| GHSA fix lineage | ≥ v0.7.3 (`252b35f`, GHSA-jpg9-m7w4-c7wc delegated-signer) | v0.8.0 ⊃ v0.7.3 fixes (released same day, 20 Oct) |
| `soroban-sdk` | OZ 0.8.0's requirement, verified at deploy time | `cargo tree` evidence lands with experiment 1 |
| Passkey Kit | PROHIBITED for prod paths (unaudited, per handoff) | — |
| Network | Stellar **testnet** only | horizon-testnet reachable (200, 2026-10-26) |

## Experiment mapping

| # | Handoff experiment | Local core (this crate, `cargo test`) | Testnet step (needs `stellar-cli` + Tobias/Theo gates) |
|---|---|---|---|
| 1 | Deploy OZ Smart Account (secp256r1 passkey, RP-ID/UV) | `auth.rs`: domain `PID\|STELLAR\|SMART_ACCOUNT\|v1`, all-policy-fields digest, RP-ID/UV/challenge checks, sponsor-downgrade regression | Deploy OZ `=0.8.0` account to testnet, register + assert passkey |
| 2 | Counterfactual `deployed_address()` vs actual deploy parity (salt = sha256(pid)) | `salt.rs`: salt vectors cross-checked vs TS `pidToSeed32` | `deployer().with_address(deployer, salt)` predict → deploy → assert equal |
| 3 | Relayer-as-source loop: quote → 120%-drift re-quote → `feeCharged` reconciliation + rent/restore accounting | `fees.rs`: MAX(50%, 0.01 XLM) stroop math, drift gate, user-cap, TTL→ledgers, reconciliation adapter | Simulation quote via RPC, funded relayer run, `feeCharged` vs attested compare |
| 4 | Nonfinancial-only context rule attempting token transfer (must fail) | `rules.rs`: catalogue invariant + must-fail authorization tests | Same attempt against the testnet account (expect `UnauthorizedFinancialOp`-class deny) |

## Run evidence (filled as testnet steps execute)

- [ ] Exp 1 tx hash / testnet address / measured fee+rental:
- [ ] Exp 2 predicted vs actual address:
- [ ] Exp 3 quoted vs attested vs feeCharged + rent/restore lines:
- [ ] Exp 4 denied-transfer tx / error:

## Gates (binding before any implementation beyond Phase-0)

1. Stellar supplement spec (Theo): payload layout, rule catalogue, maxTotalFee semantics, quote/drift/TTL mapping — build starts on acceptance.
2. Security review (Tobias): every policy field in passkey-signed digest + sponsor-downgrade regression (`auth.rs` test is the draft exhibit).
3. Rent/quote design: bump-on-access + TTL-cron, RPC-simulation quote path, ≤600s TTL + per-session seq, `feeCharged` reconciliation adapter.
4. Phase discipline: testnet-only → external audit → mainnet (ANT-542 G10). Chain-registry row (`namespace: "stellar"`), `@peridotvault/pid-stellar`, derivation parity test — Phase-1 scope.
