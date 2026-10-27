# PeridotID Stellar P1 factory — testnet deploy handoff (ANT-711 → ANT-710)

Testnet-only. Not audited, never mainnet. Passkey Kit PROHIBITED in prod
paths — auth goes through OZ external verifiers wired as `Signer::External`.

Owner of everything below the line: Trevor (DevOps, ANT-710). Troy (ANT-711)
built and verified the wasm; Trevor runs the transactions, RPC verification,
registry re-seed, rent sims, and cron ops.

## Artifacts (in this branch `pc/peridotid-stellar-p1-709`)

| Artifact | Path | sha256 |
|---|---|---|
| Account wasm | `contracts/stellar-account/wasm/peridot_stellar_account.wasm` | `0be4974994827c7b653e6d1cb1221f21068ba0f75414302af768828fc59b5bdf` |
| Factory wasm | `contracts/stellar-factory/wasm/peridot_stellar_factory.wasm` | `c33c6424ac69793bd63c1120b791325e3d33b82246b3fbf5177b41c5a936b3bf` |

Sizes: account 72649 B, factory 13199 B. Built with `stellar contract build`
(stellar 28.1.0), `overflow-checks = true` release profile.
Rebuild: `cd contracts/stellar-account && stellar contract build`,
`cd contracts/stellar-factory && stellar contract build`, then re-sha256.
The factory unit tests `contractimport!` the account wasm from
`contracts/stellar-account/wasm/` — rebuilding the account wasm requires
re-running the factory tests.

## Dependency pins (S1 §1)

- `stellar-accounts =0.8.0` (both crates)
- `soroban-sdk =28.0.0` — OZ 0.8.0's requirement, verified by `cargo tree`:

```text
peridot-stellar-factory v0.1.0
├── soroban-sdk v28.0.0
└── stellar-accounts v0.8.0
    └── soroban-sdk v28.0.0 (*)
```

## Salt derivation (S1 §1, AC1.6/AC1.7)

`salt = sha256(normalize(pid))`, full 32B, byte-identical to `pidToSeed32`
and to the `salt.rs` local core. Sample pid `ifal@pid`:

```text
salt_hex = 98bc15cccd4fd3a85b71e5b29b430d0cc461e7b5ebb7ac1b13428299ce52cfe7
```

## Deployer identity (counterfactual namespace owner)

Trevor's funded testnet identity: `GA4WH3ZIX73RRMLVG4KAP5V5OKDZ4OFXLK6RUOPNWZOXKN2ZSN2RYRHR`
(source alias `trevor-p1-testnet`). Supersedes the `GCILFP75…BADRU` identity
from the first handoff — that key file died with a run-scoped config dir
(Trevor, ANT-710 wake 2026-10-27). If the deployer changes again, ALL three
addresses below (CLI `id`, on-chain `predict_for_pid`, actual deploy) change
together — that is the expected counterfactual binding, not a bug.

## Exact commands (run from the repo root on this branch)

```sh
# 0. Sanity: salt for the sample pid (must print the salt_hex above)
python3 -c "import hashlib; print(hashlib.sha256(b'ifal@pid').hexdigest())"

# 1. Upload the account wasm (returns ACCOUNT_WASM_HASH — must equal the
#    sha256 of the account wasm file above)
stellar contract upload \
  --wasm contracts/stellar-account/wasm/peridot_stellar_account.wasm \
  --network testnet --source-account trevor-p1-testnet

# 2. Deploy the factory, pinning the account wasm hash
stellar contract deploy \
  --wasm contracts/stellar-factory/wasm/peridot_stellar_factory.wasm \
  --network testnet --source-account trevor-p1-testnet \
  -- --account-wasm-hash <ACCOUNT_WASM_HASH>
# → FACTORY_ID

# 3. On-chain predict (read-only; --send no sends no transaction)
stellar contract invoke \
  --id <FACTORY_ID> --network testnet --source-account trevor-p1-testnet \
  --send no -- predict-for-pid \
  --deployer GA4WH3ZIX73RRMLVG4KAP5V5OKDZ4OFXLK6RUOPNWZOXKN2ZSN2RYRHR \
  --pid 'ifal@pid'

# 4. Off-chain counterfactual (no RPC write; must equal step 3 output) —
#    AC1.4 predict→deploy parity gate
stellar contract id wasm \
  --salt 98bc15cccd4fd3a85b71e5b29b430d0cc461e7b5ebb7ac1b13428299ce52cfe7 \
  --source-account GA4WH3ZIX73RRMLVG4KAP5V5OKDZ4OFXLK6RUOPNWZOXKN2ZSN2RYRHR \
  --network testnet

# 5. Deploy the pilot account through the factory (returns the predicted
#    address; initial shape = 1 Delegated signer, no policies — Trevor
#    chooses the pilot signer set; External passkey signers come later
#    with the verifier contract address)
stellar contract invoke \
  --id <FACTORY_ID> --network testnet --source-account trevor-p1-testnet \
  -- deploy \
  --deployer GA4WH3ZIX73RRMLVG4KAP5V5OKDZ4OFXLK6RUOPNWZOXKN2ZSN2RYRHR \
  --pid 'ifal@pid' \
  --signers '[{"Delegated":"GA4WH3ZIX73RRMLVG4KAP5V5OKDZ4OFXLK6RUOPNWZOXKN2ZSN2RYRHR}]' \
  --policies '{}'
```

## Test evidence (this branch, 2026-10-27 — require_auth fix)

- `contracts/stellar`: **38 passed, 0 failed** (S1 local AC green, unchanged)
- `contracts/stellar-account`: **9 passed, 0 failed** — includes T3 golden
  scope-hash vectors byte-identical to the local cores
  (`3ec34e…`, `fdbb3e…`, `01853f…`), DOMAIN_V2 28B, cross-network digest
  split, snapshot pin, min(expiry) gates
- `contracts/stellar-factory`: **6 passed, 0 failed** — pid salt vectors
  byte-identical to `salt.rs` (`98bc15cc…`, `d7824b…`, `12fcda…`),
  AC1.6 distinctness, AC1.7 fail-closed (4/8/0/31/33-byte salts), and
  **predict→deploy parity against the real account wasm**
  (`predict_for_pid == deploy`, distinct pid ⇒ distinct address,
  distinct deployer ⇒ distinct address). Deploy tests run under a
  **root-only** auth mock — reverting the `deployer.require_auth()` line
  makes them fail with the same host `Auth.InvalidAction` seen on testnet
  (verified by toggle), so the on-chain defect class is pinned.

## Residual risk / follow-ups (for Trevor, ANT-710)

- On-chain G1 byte-equality (`auth_digest` vs SDK-canonical XDR) and the
  WebAuthn `verify` assertion still need the live testnet pass (Exp-1b/1c
  pattern); the `intent_digest` helper pins the inner D, the outer OZ
  `AuthDigestPreimage` binding is OZ-enforced at `__check_auth`.
- Full G2 snapshot table beyond (version + rows) and the `execute`
  passkey-authorized call are Phase-1 follow-ups; `ExecutionEntryPoint`
  (self-auth) ships in the account contract now.
- No mainnet vectors anywhere in these crates (no mainnet passphrase, no
  mainnet RPC); factory has no upgrade path by design — rotate by deploying
  a new factory.

## ANT-712 residual close-out (Troy, 2026-10-27 — AC2.8 + AC3.4 on-chain)

Operator: `contracts/stellar-account/scripts/ac712/` (README there has the
full command log + 8 host/SDK findings). New crate `contracts/stellar-policy`
(OZ `Policy`, deny-first FINANCIAL_FNS mirror of `rules.rs`): **10/10 cargo
tests**; in-tree wasm is v2 with the execute-dispatch layer
(`2fd03ff3…71d63b568f`; v1 `4fadfcca…3013a0bc3e35` superseded on-chain). Reference actors
(all testnet): passkey-only pilot `CA2XGFLW…LAB36` (rule 0 = External only),
verifier `CD7HL6U…LQLL7QXSDB` (Phase-0, confirmed live, reused), policy v1
`CDCPKVIJ…7QZYVP`, policy v2 `CBMNKK7T…DZAMPAD5`, native SAC `CDLZFC3S…YGCYSC`.

| Item | Evidence |
|---|---|
| (a) Verifier | Phase-0 contract fetchable + spec-checked live; no redeploy |
| External signer on pilot | Constructor-bound at deploy (tx `e3653886…` pilot #4, `4a99e039…` pilot #5, predict == deploy both) |
| (c) Passkey EXECUTE | `execute(verifier, canonicalize_key, …)` via External signer, tx **`f7ac3032…`** SUCCESS, on-chain `verify=true` |
| G1 byte-equality | On-chain `auth_digest(preimage)` = `8bf61223…2824b9` == SDK sha256(XDR) over the submitted envelope's `(nonce, expiration, invocation)` == the signed challenge D |
| (d) Replay-reject | Same assertion, fresh envelope → enforce-sim `#3114 ChallengeInvalid`; submitted tx **`5defe5cb…`** FAILED with on-chain `#3114` |
| AC3.4 token-deny | Rule 2 (`nonfinancial-only-v2` + policy v2, tx `425259c6…`); decimals probe tx `34887291…` SUCCESS (rule authorizes, policy passes); `execute(SAC, transfer, …)` → enforce-sim contract `#1`, submitted tx **`cdfc24ad…`** FAILED with on-chain `UnauthorizedFinancialOp` (`enforce` → `fail_with_error #1` on the transfer dispatch) |

Local suites at close-out: stellar 38/38, stellar-account 9/9,
stellar-factory 6/6, stellar-policy 10/10, `@peridotvault/pid-stellar` 13/13,
ac712 operator 10/10.

Known residual: Delegated (G-key) nested self-auth (`AuthPayload{Delegated}`
+ nested `__check_auth(preimage)` entry, OZ-documented) fails on testnet with
`Auth/InvalidAction` despite a byte-matching outer payload — undiagnosed
invocation-match issue (host 28.0.2 reviewed; OZ tests only cover nested auth
with contract delegates). Nothing in AC2.8/AC3.4 depends on it (all flows are
passkey-only, single-entry). Flagged as follow-up for Tobias (auth-path
semantics, audit-adjacent).
