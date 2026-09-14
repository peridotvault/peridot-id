# Peridot SVM contracts

Pinocchio smart-account program — the on-chain half of the PeridotID personal
wallet. One identity owns one PDA, seeded `["peridot_id", "account", sha256(pid)]`,
authorized by a secp256r1 passkey verified via the precompile + instruction
introspection (ADR 005 Option B).

- `smart-account/` — the program crate (`peridot-smart-account`; package name is
  load-bearing: `.so` + keypair filenames derive from it, do not rename lightly)
  - `src/` — `lib.rs`, `state.rs`, `auth.rs`, `secp256r1.rs`, `sha256.rs`,
    `errors.rs`, `instructions/`
  - `tests/integration.mjs` — 13 adversarial cases (task 005)

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
cargo build-sbf   # -> target/deploy/peridot_smart_account.so
cargo test        # 12 unit tests
```

## Localnet

Run everything from `contracts/svm` — chain state (`test-ledger/`) lives here,
never at repo root:

```sh
cd contracts/svm
solana-test-validator --reset > /tmp/validator.log 2>&1 &
solana config set --url http://127.0.0.1:8899 && solana airdrop 5
cd smart-account
solana program deploy target/deploy/peridot_smart_account.so \
  --program-id target/deploy/peridot-smart-account-keypair.json
node tests/integration.mjs <program-id>   # 13 cases
```

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
   before launch (see `docs/tasks/012-production-hardening.md` for the full checklist).
4. Set `SOLANA_NETWORK=mainnet-beta` + 2+ production RPCs in deploy env.

One keypair everywhere = one blast radius: the multisig is the single guard.
Funds on old-program PDAs stay there — nothing migrates them.

## Notes

- `sol_sha256` syscall crashes this SBF toolchain — the program uses pure-Rust
  SHA-256 (`src/sha256.rs`); the TS mirror is `pidToSeed32` (`@peridotvault/pid-core`).
- The precompile enforces low-S and does not simulate correctly — send with
  `skipPreflight`. Expiries use the chain clock (`Clock` sysvar), not wall time.
- `target/` and `test-ledger/` are gitignored — keypairs under `target/deploy`
  are never committed.
