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

## Run evidence (testnet, 2026-10-25/26 — all executed, all hashes verifiable on horizon-testnet)

Relayer (source, testnet-only): `GD3EQ7U2LCBUI2BYJ5P5ZJJL522NR4UD5DRBQGEQCO3YLYN3TZBZJDEE`.
Network passphrase: `Test SDF Network ; September 2015`. OZ source: tag `v0.8.0`. CLI: `stellar 28.1.0`.

- [x] Exp 1a (deploy + passkey register): factory `CAFHXQEDIRVWTE2XFM676VI2MSEWEOLSCKXIUZ42WNYLCKTS7BBLHWY7`
  (deploy tx `549b713c9eeb64cd36002481728405832d1034f10d023a335684df67af6dd83`, fee 22866);
  webauthn-verifier `CD7HL6UYXQNFYGU6FARCGLA2TACYCY7PIMRDBNPKDOENLBLQLL7QXSDB`
  (deploy tx `4174b888fe36966e60866433337fa2dcb3420ad6b6fca59b476f992b3d196f1f`, fee 14826);
  account `CCGI5WB5VJ6QH7MOR2AUIBZDZ6LS6PFUG2KXBYWUGQDKQXINO5RCBCXC` deployed WITH
  `External(verifier, 65B secp256r1 pubkey 046428f8…d469762)` as signer 0 of the default
  "multisig" rule (deploy tx `9dc4d1a40eff64fe4d7dda1d9223db4f1b3f517deabdf48ba8f1a82cdaa84c36`,
  feeCharged 106132). Registration = construction-time signer binding (no separate register step in OZ model).
- [x] Exp 1b (passkey assert, RP-ID/UV): crafted WebAuthn assertion (rpId `vault.peridot.example`,
  flags `0x05` = UP+UV, challenge = base64url(D) where D = local `digest_for_intent` output
  `02c0a4ad…a631a912` bound to the testnet account) → `verifier.verify` returned **`true`**
  on-chain (tx `5a4a772fe3476efbf0284e0e9a27622366d20f9df976cabcea81615413d5c337`, feeCharged 3617).
  UV enforced on-chain (`VerifiedBitNotSet` rejects); RP-ID bound in client assertion + local
  `auth.rs` `BadRpId` check — OZ on-chain omits `rpIdHash` comparison by design (recorded deviation;
  our RP-ID enforcement lives client-side + in the intent digest, Tobias T2 cross-check).
- [x] Exp 1c (G1 digest byte-equality): on-chain `auth_digest(AuthDigestPreimage{account=CCGI…,
  signature_payload=D, context_rule_ids=[0]})` = `5d3fb64b…fe10abd` == sha256 of the SDK-canonical
  preimage XDR (reproduced in-env; Python hand-rolled XDR initially mismatched — struct encodes as
  ScMap with symbol keys per SDK v28, NOT positional ScVec; canonical bytes recorded in evidence).
- [x] Exp 2 (counterfactual parity): `predict_address(signers=[External(verifier,pubkey)], policies={}, salt=2772416322)` → `CCGI5WB5…NO5RCBCXC`; `deploy` same tuple → **identical address** (tx `9dc4d1a4…`). Salt = first-4-LE-bytes of `sha256('phase0-test@pid')` (fixture truncation documented; production salt = full 32B `sha256(pid)`, proven in `salt.rs` vectors). Second account `CDD37XM2…RSB5Q` (salt 2793133376, tx `dc94ba3c…`) confirms distinct configs → distinct addresses.
- [x] Exp 3 (relayer sponsorship loop): quote via `simulateTransaction` on identical-shape fresh deploy → `minResourceFee=125425`, restore preview empty → rent/restore lines `0` (explicit-zero, R6). All-in quote: network 125425 + protocol `MAX(50%=62712, floor 100000)` = **100000** → total_quoted **225425** (floor binds — 50% does not). Attested at submit 125525 proposed (100 inclusion + 125425 resource); drift `125425*100 ≤ 125425*120` ✓. `feeCharged` **106132** on BOTH deploys (deterministic shape) → reconcile **true** (under-charge OK; user refunded 19393 stroops). Verify-call reconcile true (3617 ≤ attested). Rent: fresh-deploy restore preview empty; archival rent inside resource fee (non-refundable 8999 of 125425).
- [x] Exp 4 (nonfinancial-only deny): local `rules.rs` — all 8 deny-listed fns (`transfer…set_admin`) must-fail + mixed-case + fail-closed registration (in `cargo test`). On-chain: duplicate-signer `deploy` → **Contract error #3007** at simulation (fail-closed before submission); unauthorized `add_signer` from relayer G-address → client refuses (missing account authority) — no unauthorized state change possible without the account's own auth. Exact token-transfer-under-rule on-chain case deferred to Phase-1 (needs token contract + full auth-entry crafting; local exhibit reviewed by Tobias).
- OQ-2 (measured rent/restore): fresh account deploy all-in 225425-quoted / 106132-charged; restore_fee 0 (no archival entries in Phase-0 shapes); TTL-cron ops per plan §AC4.5 (not yet run — Phase-1).
- OQ-4 (`soroban-sdk` version): OZ v0.8.0 pins `soroban-sdk =28.0.0` (Cargo.lock), CLI `stellar 28.1.0 / stellar-xdr 28.0.0`; in-env host `soroban-env-host 28.0.2`.

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

### Phase-1 recommendation (Troy, post-experiment)

GO for Phase-1 implementation scope, bounded as follows (no Revise needed — all four experiments
support the handoff; open items are scoped, not blocking):
1. Production factory with 32B `salt = sha256(pid)` (fixture used u32 truncation), `soroban-sdk`
   version re-verified at build (`cargo tree`), `@peridotvault/pid-stellar` package + chain-registry
   row (`namespace: "stellar"`).
2. Full passkey-authorized `execute` via the account (auth-entry crafting in SDK) to close the last
   mile of Exp-1 (registration + verify + digest-equality already on-chain).
3. Token contract + exact nonfinancial-rule `transfer` deny on-chain (Exp-4 exact case).
4. Pre-mainnet must-close: F1 (DOMAIN v2 network binding), G2 (32B→u32 rule-ID map pinning),
   `min(OZ valid_until, expiry_ledger)`, T3 (scope canonicalization), external audit (ANT-542 G10).
5. TTL-cron execution + measured steady-state rent at pilot scale (OQ-2 follow-up).

Residual risk: LOW for testnet scope (test keys only, friendbot funds, no mainnet touch).
Audit-surface: no new warnings beyond the recorded F1/G2/e items (Tobias reviewed 2026-10-25/26);
RP-ID on-chain omission is an OZ design stance, mitigated client-side + digest-side.

### TTL-cron ops plan (spec AC4.5)

Off-chain cron ≥ 1 run/24h reads account TTL via RPC, bumps when remaining < ~17k ledgers (48h-equivalent); alerts on 3 consecutive bump failures (MTTR ≤ 15 min); cron uses a dedicated bump-only signer with no rule rights. Bump entry set (account instance + frequently-read entries) recorded per-experiment in the evidence table above. NFRs: quote p95 ≤ 3s, cron bump cost ≤ 2× typical total_fee.
