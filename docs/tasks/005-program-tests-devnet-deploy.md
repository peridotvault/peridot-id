# 005 — Program Tests + Devnet Deploy

## Status

implemented (2026-08-28) — secp256r1 passkey adversarial suite + devnet deploy.

## Results

**Deployed:** program id `CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT` (devnet),
upgrade authority `EJq6txD8FBD8tcy6TCEX5Fv1oU1oX6zHFLxq1mp1EeH9` (dev keypair — hardened in
task 012). Keypair: `programs/peridot-smart-account/target/deploy/peridot-smart-account-keypair.json`
(never committed). Devnet id is never reused for mainnet (ADR 007 §9).

**Rust unit tests** (`cargo test`, 12 tests): sha256 vectors, secp256r1 instruction parser
(offsets/fields/bounds), base64url decode, clientDataJSON challenge extraction, payload
domain separation.

**Integration suite** (`tests/integration.mjs`, run against `solana-test-validator`): all
13 cases pass deterministically —
initialize / state layout / re-initialize rejected / withdraw valid / unauthorized passkey
rejected / replay (nonce) rejected / invalid nonce rejected / expired expiry rejected /
challenge–args mismatch (tx substitution) rejected / account (PDA) mismatch rejected /
malformed instruction rejected / update_authority valid / rotation (old rejected, new
accepted).

**Compute budget:** a full withdraw (program + secp256r1 precompile) consumes
**~36,500 compute units** — comfortably within the 200k budget; the ADR 005 compute
checkpoint passes with no optimization needed.

## Key findings recorded for downstream tasks

- The **Secp256r1 precompile enforces low-S signatures** — the SDK (task 009) must
  normalize `s` to `≤ N/2` (confirmed against the runtime source).
- The precompile does **not** verify correctly under `simulateTransaction` in this
  validator; tests and the SDK must send with `skipPreflight` and rely on real execution.
- The on-chain **expiry check uses the chain clock** (`Clock` sysvar) — the client must
  build expiries relative to the validator's block time, not the device clock.
- The compressed public-key parity bit is `y[31] & 1` (not the x-coordinate).
- The `sol_sha256` syscall crashes this SBF toolchain; the program uses a pure-Rust
  SHA-256 (`src/sha256.rs`).

## PRD References

- PRD_v5 §5; PRD_v4 §27 (Program Tests, Unit Tests), §28 (Solana), §24 (rules under test)

## How to run

```sh
# Rust unit tests
cargo test

# Integration suite (local validator must be running, program deployed)
solana-test-validator --reset > /tmp/validator.log 2>&1 &
solana program deploy target/deploy/peridot_smart_account.so \
  --program-id target/deploy/peridot-smart-account-keypair.json
node tests/integration.mjs        # needs @solana/web3.js@1 (npm i in a scratch dir)
```

## Out of Scope

- Mainnet deploy and upgrade-authority hardening (task 012).
- Full E2E through the API/SDK/client (task 011).