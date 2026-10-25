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

1. Stellar supplement spec (Theo, ANT-553): **ACCEPTED 2026-10-26** — draft CONFIRMED with 6 bounded revisions, all incorporated in this crate:
   R1 `TooManyRules` (>8 rule IDs, `auth.rs`), R2 strict `nonce == stored+1` + no-wrap (`check_nonce`), R3 reserved `0x12` op tag documented, R4 deny-first exact case-sensitive ordering (contractual), R5 closed 4-class catalogue + `rule_id_for` derivation (`rules.rs`), R6 all-in drift gate + itemized `Quote` (`fees.rs`).
2. Security review (Tobias, ANT-554): **APPROVE WITH CHANGES 2026-10-26** — T1 multi-rule order/subset test + T2 `authenticator_data[0..32]` cross-check incorporated; T3 (scope descriptor→hash binding test) deferred — scope canonical encoding still open (Phase-1 follow-up).
3. Rent/quote design: itemized `Quote` + RPC-simulation path (spec §4.1) + TTL-cron ops plan recorded below (AC4.5).
4. Phase discipline: testnet-only → external audit → mainnet (ANT-542 G10). Chain-registry row (`namespace: "stellar"`), `@peridotvault/pid-stellar`, derivation parity test — Phase-1 scope.

### Pre-mainnet items (explicitly NOT Phase-0 — recorded, not implemented)

- **F1 (Tobias):** preimage has no network/passphrase binding — add before mainnet (DOMAIN v2).
- **G2 (Tobias):** OZ rule IDs are auto-increment `u32`, ours are `[u8;32]` hashes — pin the 32B→u32 map (registry snapshot at registration) before any rule beyond the Phase-0 fixture.
- **e (Tobias):** enforce `min(OZ rule valid_until, intent expiry_ledger)` on-chain.
- **OQ-2 (Troy):** measured rent/restore costs for the pilot account shape — with Exp-3 evidence.
- **OQ-4 (Troy):** `soroban-sdk` exact version verification at deploy (`cargo tree` evidence) — with Exp-1 evidence.

### Experiment-1 on-chain assertions (Tobias F3/G1/deploy notes)

The testnet deploy MUST assert: (a) on-chain nonce consumption (submit + replay-reject), (b) byte-equality between `digest_for_intent` output and the Soroban `signature_payload`, (c) self-auth-gated rule management (`add_context_rule` requires account self-auth), (d) real secp256r1 passkey verification (the local `verify_webauthn_assertion` is necessary-but-not-sufficient).

### TTL-cron ops plan (spec AC4.5)

Off-chain cron ≥ 1 run/24h reads account TTL via RPC, bumps when remaining < ~17k ledgers (48h-equivalent); alerts on 3 consecutive bump failures (MTTR ≤ 15 min); cron uses a dedicated bump-only signer with no rule rights. Bump entry set (account instance + frequently-read entries) recorded per-experiment in the evidence table above. NFRs: quote p95 ≤ 3s, cron bump cost ≤ 2× typical total_fee.
