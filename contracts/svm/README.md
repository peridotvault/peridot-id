# Peridot SVM contracts

Pinocchio smart-account program — the on-chain half of the PeridotID personal
wallet. One identity owns one PDA, seeded `["peridot_id", "account", sha256(pid)]`,
authorized by a secp256r1 passkey verified via the precompile + instruction
introspection (secp256r1 owner passkey).

- `smart-account/` — the program crate (`peridot-smart-account`; package name is
  load-bearing: `.so` + keypair filenames derive from it, do not rename lightly)
  - `src/` — `lib.rs`, `state.rs`, `auth.rs`, `fee.rs`, `secp256r1.rs`, `sha256.rs`,
    `errors.rs`, `programdata.rs`, `instructions/` (V3 authorization schema — `contracts/WHITEPAPER.md` §§2, 6;
    session layer discs 7–10 — `contracts/WHITEPAPER.md` §11, ADR-010)
  - `tests/integration.mjs` — adversarial cases incl. squat, non-canonical-vault,
    over-attested-fee policy checks (formula + drift + TTL),
    cross-account replay and TTL cases (task 005)
  - `tests/session.mjs` — session adversarial suite (24 cases: PDA isolation,
    forwarding bounds, protected invariants, replay, lifecycle; needs the mock
    forwarder below)
- `mock-forwarder/` — adversarial test helper ONLY (never deployed beyond
  localnet): forwards received signer bits to a third program, proving what
  signer forwarding can and cannot move

## Prereqs

Pinned toolchain — newer breaks the build:

```sh
export PATH="$HOME/.local/share/solana/install/releases/2.3.13/solana-release/bin:$PATH"
solana --version  # 2.3.13
```

- Pinocchio `0.10.2` + `solana-address =2.1.0` (newer needs rustc 1.89; MSRV is 1.84).
- `cargo update` must not drift these (versions are pinned in `Cargo.toml`).

## Build & unit tests

```sh
cd contracts/svm/smart-account
PID_BACKEND=<backend-pubkey-base58> PID_TREASURY=<treasury-pubkey-base58> cargo build-sbf   # -> target/deploy/peridot_smart_account.so
cargo test        # unit tests (auth vectors, fee policy, domain separation)
```

`PID_BACKEND` / `PID_TREASURY` are baked in by `build.rs` (`src/config.rs`): only
`BACKEND` may pay for `initialize` / relay `activate` — the PID-ownership proof
that makes squatting and prefund-drain impossible — and the protocol fee goes to the
canonical `TREASURY` revenue vault (defaults to `BACKEND` when unset). Same program
id on every cluster, backend/treasury consts per env; neither enters PDA derivation. Unset
`PID_BACKEND` = creation disabled (fail-closed zeros). Local integration tests use
the test key `5as9TQo7Ua5iEBCKRbPhFUiRQX5dRJpjEQ9V91WddzaZ` (secret in
`tests/integration.mjs`, test-only).

## Localnet

Run everything from `contracts/svm` — chain state (`test-ledger/`) lives here,
never at repo root:

```sh
cd contracts/svm
solana-test-validator --reset > /tmp/validator.log 2>&1 &
solana config set --url http://127.0.0.1:8899 && solana airdrop 5
cd smart-account
solana program deploy target/deploy/peridot_smart_account.so \
  --program-id target/deploy/peridot_smart_account-keypair.json
node tests/integration.mjs <program-id>   # 37 cases (PID_BACKEND + PID_TREASURY test-key build)
# Session suite (needs the mock forwarder deployed; forwarder id passed as argv[3]):
solana-keygen new -o /tmp/forwarder-keypair.json --no-bip39-passphrase
solana program deploy ../mock-forwarder/target/deploy/peridot_mock_forwarder.so \
  --program-id /tmp/forwarder-keypair.json
node tests/session.mjs <program-id> <forwarder-id>   # 24 session cases (ADR-010)
```
No deploy key handy (the declared id's keypair is secret)? Load the binary at its
declared address instead — program-id check passes, upgrades don't apply locally:
`solana-test-validator --reset --bpf-program CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT target/deploy/peridot_smart_account.so`.

Wire the API to it (`apps/api/.env`):

```sh
PID_PROGRAM_ID=<deployed-program-id>
SOLANA_NETWORK=devnet
PID_SOLANA_RPC_URL=http://127.0.0.1:8899
```

## Testnet (devnet)

Same flow against devnet with a funded deployer keypair:

```sh
cd contracts/svm/smart-account
solana config set --url https://api.devnet.solana.com
solana program deploy target/deploy/peridot_smart_account.so \
  --program-id target/deploy/peridot-smart-account-keypair.json
node tests/integration.mjs <program-id>
```

Current devnet program id: `CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT`.

## One wallet on every cluster (same program id)

The PDA is `find_program_address(["peridot_id","account",sha256(pid)], program_id)` —
a pure function, so **reusing one program keypair on every cluster gives one pid
one address on localnet, devnet, testnet and mainnet** (balances stay per-chain;
only the address unifies — the EVM equivalent of the shared factory).

Rule: `target/deploy/peridot-smart-account-keypair.json` is canonical. Deploy
testnet and mainnet with `--program-id` pointing at that same file. Never
`solana-keygen new` per env — a fresh id moves every wallet. Guard the file like
a secret until the upgrade authority is on the multisig.
Point the API at it (`PID_PROGRAM_ID`, `PID_SOLANA_RPC_URL=https://api.devnet.solana.com`)
and exercise `packages/sdk-js/test/devnet.e2e.mjs`.

## Mainnet

Deploy with the **same** program keypair (see above) — new id = new addresses
everywhere (the id is part of the PDA derivation). Procedure, not values:

1. Reuse the canonical program keypair. Never generate a fresh one per env.
2. Fund a deployer, deploy, verify the id on-chain.
3. Transfer the upgrade authority to a **stakeholder-held hardware/multisig key**
   before launch (see `contracts/WHITEPAPER.md` §12 for the audit gate).
4. Set `SOLANA_NETWORK=mainnet-beta` + 2+ production RPCs in deploy env.

One keypair everywhere = one blast radius: the multisig is the single guard.
Funds on old-program PDAs stay there — nothing migrates them.

## Notes

- `sol_sha256` syscall crashes this SBF toolchain — the program uses pure-Rust
  SHA-256 (`src/sha256.rs`); the TS mirror is `pidToSeed32` (`@peridotvault/pid-core`).
- The precompile enforces low-S and does not simulate correctly — send with
  `skipPreflight`. Expiries use the chain clock (`Clock` sysvar), not wall time;
  authorization TTL is capped at 600s on-chain (`auth::MAX_TTL_SECS`).
- State is versioned: v1 (80B) reads remain valid, writers stamp v2 (112B with
  RP-ID hash). V2 spends/rotations require v2 state (`MissingRpIdHash` otherwise).
- `target/` and `test-ledger/` are gitignored — keypairs under `target/deploy`
  are never committed.
