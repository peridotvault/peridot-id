# Peridot SVM contracts

Pinocchio smart-account program — the on-chain half of the PeridotID personal
wallet. One identity owns one PDA, seeded `["peridot_id", "account", sha256(pid)]`,
authorized by a secp256r1 passkey verified via the precompile + instruction
introspection (secp256r1 owner passkey).

- `smart-account/` — the program crate (`peridot-smart-account`; package name is
  load-bearing: `.so` + keypair filenames derive from it, do not rename lightly)
  - `src/` — `lib.rs`, `state.rs`, `auth.rs`, `fee.rs`, `secp256r1.rs`, `sha256.rs`,
    `errors.rs`, `programdata.rs`, `instructions/` (V3 authorization schema — `contracts/WHITEPAPER.md` §§2, 6;
    session layer discs 7–10 — `contracts/WHITEPAPER.md` §11)
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
PID_TREASURY=<treasury-pubkey-base58> cargo build-sbf   # -> target/deploy/peridot_smart_account.so
PID_TREASURY=<treasury-pubkey-base58> cargo test        # unit tests (auth vectors, fee policy, domain separation, ANT-612 pins)
```

`PID_TREASURY` is baked in by `build.rs` (`src/config.rs`) and REQUIRED — an
unset treasury is a build-time hard error (no silent default; a zero recipient
would burn protocol fees). Creation is permissionless (ANT-612, ANT-610 spec
§5): ANY funded signer may submit `activate` / `activateV4` — anti-squat is the
user's passkey signature alone (the payload binds `account_id ‖ authority`),
and every claim still splits `relayerFee → submitter` + `protocolFee → TREASURY`.
Direct `initialize` (disc 0) is dead in all builds (`InitializeDeprecated`).
Same program id on every cluster, treasury const per env; neither enters PDA
derivation. Creation is permissionless: `build.rs` bakes in no creation gate —
only `PID_TREASURY` and the program-id inputs.

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
node tests/integration.mjs <program-id>   # 44 cases (PID_TREASURY test-key build; permissionless-creation proofs)
# Session suite (needs the mock forwarder deployed; forwarder id passed as argv[3]):
solana-keygen new -o /tmp/forwarder-keypair.json --no-bip39-passphrase
solana program deploy ../mock-forwarder/target/deploy/peridot_mock_forwarder.so \
  --program-id /tmp/forwarder-keypair.json
node tests/session.mjs <program-id> <forwarder-id>   # 24 session cases (WHITEPAPER.md §11)
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

Same flow against devnet with a funded deployer keypair. The program id is
build-configurable (ANT-211): `PID_PROGRAM_ID` baked by `build.rs` defaults to
the local/devnet address `CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT`; the
testnet program lives at `D6TpM7caN3tG31Trq6cffKKnWbS4pP7nWJJbd2ALVsg3`, so a
testnet build MUST set the env before compiling — a default-ID binary bricks
on testnet (`IncorrectProgramId`; QA proved at ANT-202). PDA derivation uses
the runtime program id, so existing testnet accounts stay valid under upgrades
built with the matching `PID_PROGRAM_ID`.

```sh
cd contracts/svm/smart-account
PID_PROGRAM_ID=D6TpM7caN3tG31Trq6cffKKnWbS4pP7nWJJbd2ALVsg3 cargo build-sbf
solana config set --url https://api.testnet.solana.com
solana program upgrade target/deploy/peridot_smart_account.so \
  --program-id <testnet-keypair.json>   # upgrade authority held by DevOps
node tests/integration.mjs D6TpM7caN3tG31Trq6cffKKnWbS4pP7nWJJbd2ALVsg3
```

Deploy guard (ANT-215, Tobias ANT-212 Finding 3): before `cargo build-sbf`,
assert the env equals the cluster keypair — a typo that still decodes to 32
bytes builds green and bricks at runtime, and only this equality check catches
it. Same `PID_PROGRAM_ID` value for guard and build:

```sh
PID_PROGRAM_ID=D6TpM7caN3tG31Trq6cffKKnWbS4pP7nWJJbd2ALVsg3 \
  ../assert-program-id.sh --keypair <testnet-keypair.json> --require-explicit
PID_PROGRAM_ID=D6TpM7caN3tG31Trq6cffKKnWbS4pP7nWJJbd2ALVsg3 cargo build-sbf
```

`--require-explicit` forbids the silent local/devnet default; `build.rs`
enforces the same rule at compile time when `PID_PROGRAM_ID_REQUIRED=1` (or
`SOLANA_CLUSTER=testnet*/mainnet*`) is set. 3am rule: if the guard fails with
a mismatch, do NOT deploy — re-export the exact pubkey
(`solana-keygen pubkey <testnet-keypair.json>`) and rebuild.

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

Caveat (ANT-211): testnet currently runs under a distinct address
(`D6TpM7…`, not the canonical `CiwLJ…`), so testnet PDAs differ from
local/devnet PDAs for the same pid. That is exactly why the program id is now
build-configurable — always build with the `PID_PROGRAM_ID` of the cluster
you deploy to.

## Mainnet

Deploy with the **same** program keypair (see above) — new id = new addresses
everywhere (the id is part of the PDA derivation). Procedure, not values:

1. Reuse the canonical program keypair. Never generate a fresh one per env.
2. Fund a deployer, then run the ATOMIC deploy+init flow below — never a bare
   `solana program deploy`. Init must land in the same operator execution as
   the deploy (same operator keypair as initer == initial admin, ANT-801 H3),
   or a frontrunner wins the deploy->init race and self-appoints (first-writer
   wins, and owns the fee stream via WithdrawRevenue).
3. Transfer the upgrade authority to a **stakeholder-held hardware/multisig key**
   before launch (see `contracts/WHITEPAPER.md` §12 for the audit gate).
4. Set `SOLANA_NETWORK=mainnet-beta` + 2+ production RPCs in deploy env.

## Atomic deploy + treasury init (ANT-806, all clusters incl. mainnet)

No mainnet execution without a board order. Operator flow (one execution):

```sh
# 0. Build with the cluster program id baked in (guarded by ANT-215):
PID_PROGRAM_ID=<program-id> ../assert-program-id.sh \
  --keypair <program-keypair.json> --require-explicit
PID_PROGRAM_ID=<program-id> cargo build-sbf
# 1+2. Deploy AND init_treasury back-to-back, verify admins[0] == operator:
./deploy/svm-deploy-init-atomic.sh \
  --program-keypair <program-keypair.json> \
  --operator-keypair <operator-keypair.json> \
  --rpc-url <cluster-rpc> \
  --so-path contracts/svm/smart-account/target/deploy/peridot_smart_account.so
# fresh program: omit --upgrade. Existing program: add --upgrade.
```

What the script enforces (fail-closed, exit non-zero = do NOT cut over):

- Same operator keypair signs the deploy AND the `init_treasury` (disc 15)
  with `initial_admin == initer` (on-chain H3 binding; no delegated appoint).
- Post-send verify reads the `[b"config"]` PDA: len 264, version 1,
  `admins[0] == operator`, program-owned config + treasury.
- Pre-check makes retries safe: already-initialized-with-operator exits 0;
  initialized-with-stranger exits 3 (RACE LOST — redeploy under a FRESH
  program keypair, never reuse a raced id: init is first-writer-wins and
  irreversible on that program id).

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
