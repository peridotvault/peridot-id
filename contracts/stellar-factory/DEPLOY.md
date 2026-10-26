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
| Factory wasm | `contracts/stellar-factory/wasm/peridot_stellar_factory.wasm` | `6f07e249006ac1a7e89d8f6bfab0a0b0072a8134bf4cdb25a06fcbafeaaefcc1` |

Sizes: account 72649 B, factory 13178 B. Built with `stellar contract build`
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

Trevor's funded testnet identity: `GCILFP75RYHAJA5IFGFO2TFDVFTWJDKFIP5EBYKS2OZRRSB6JMJBADRU`
(source alias `trevor-p1-testnet`). If a different deployer is required, ALL
three addresses below (CLI `id`, on-chain `predict_for_pid`, actual deploy)
change together — that is the expected counterfactual binding, not a bug.

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
  --deployer GCILFP75RYHAJA5IFGFO2TFDVFTWJDKFIP5EBYKS2OZRRSB6JMJBADRU \
  --pid 'ifal@pid'

# 4. Off-chain counterfactual (no RPC write; must equal step 3 output) —
#    AC1.4 predict→deploy parity gate
stellar contract id wasm \
  --salt 98bc15cccd4fd3a85b71e5b29b430d0cc461e7b5ebb7ac1b13428299ce52cfe7 \
  --source-account GCILFP75RYHAJA5IFGFO2TFDVFTWJDKFIP5EBYKS2OZRRSB6JMJBADRU \
  --network testnet

# 5. Deploy the pilot account through the factory (returns the predicted
#    address; initial shape = 1 Delegated signer, no policies — Trevor
#    chooses the pilot signer set; External passkey signers come later
#    with the verifier contract address)
stellar contract invoke \
  --id <FACTORY_ID> --network testnet --source-account trevor-p1-testnet \
  -- deploy \
  --deployer GCILFP75RYHAJA5IFGFO2TFDVFTWJDKFIP5EBYKS2OZRRSB6JMJBADRU \
  --pid 'ifal@pid' \
  --signers '[{"Delegated":"GCILFP75RYHAJA5IFGFO2TFDVFTWJDKFIP5EBYKS2OZRRSB6JMJBADRU}]' \
  --policies '{}'
```

## Test evidence (this branch, 2026-10-26)

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
  distinct deployer ⇒ distinct address)

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
