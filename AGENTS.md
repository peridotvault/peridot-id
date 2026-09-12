# AGENTS.md — PeridotID conventions

Project: **PeridotID** (repo `peridot-id`, short **`pid`**). Gaming identity wallet —
non-custodial Solana smart account with a **secp256r1 passkey** authority.

## Naming conventions (keep consistent)

- **Brand:** `PeridotID` in product copy; `peridot_id` for the Postgres DB name; `pid`
  for long identifiers (cookies `pid_access`/`pid_refresh`, table `pid_accounts`, env
  `PID_*`). "Peridot ecosystem" refers to the wider Peridot products — a different thing.
- **NPM packages:** `@peridotvault/pid-*` (npm org: `@peridotvault`; company: PT ANTIGANE LABS INDONESIA) — e.g.
  `@peridotvault/pid-api`, `@peridotvault/pid-types`, `@peridotvault/pid-sdk-js`, `@peridotvault/pid-solana`,
  `@peridotvault/pid-evm`, `@peridotvault/pid-openapi`, `@peridotvault/pid-web`, `@peridotvault/pid-wallet`.
- **On-chain:** PDA seed `["peridot_id", "account", account_id]`; signed-payload domain
  `PID|SOLANA|SMART_ACCOUNT|v1`; program id `CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT`.
- **Identity:** PID = `pid_<ULID>`; identity credentials key on `(provider, providerUserId)`.

## Environment

- **Postgres DB:** `peridot_id` at `localhost:5432` (NOT `peridot`). `DATABASE_URL` in
  `apps/api/.env`.
- **Solana toolchain:** 2.3.13 at
  `~/.local/share/solana/install/releases/2.3.13/solana-release/bin` (platform-tools v1.48,
  rustc 1.84). The `active_release` symlink may point at a newer agave — use the 2.3.13
  path explicitly for `cargo build-sbf`.
- **Pinocchio** pinned to **0.10.2** (+ `solana-address =2.1.0`) because newer needs
  rustc 1.89. MSRV constraint is a hard build requirement.
- `packages/solana` is the only package allowed to import `@solana/web3.js` (ADR 007 §8).

## Run book (local)

```sh
export PATH="$HOME/.local/share/solana/install/releases/2.3.13/solana-release/bin:$PATH"
solana-test-validator --reset > /tmp/validator.log 2>&1 &
solana config set --url http://127.0.0.1:8899 && solana airdrop 5
cd programs/peridot-smart-account
solana program deploy target/deploy/peridot_smart_account.so \
  --program-id target/deploy/peridot-smart-account-keypair.json
pnpm --filter @peridotvault/pid-api dev        # API on :3301
cd apps/wallet && pnpm dev:web         # Expo web on :8081
```

Env to set in `apps/api/.env`: `GOOGLE_CLIENT_ID_DEV`/`_SECRET_DEV` (dev Google
client with localhost redirect; `_PROD` only in deploy env), `PID_PROGRAM_ID=G8tPC...`,
`WEBAUTHN_ORIGINS` includes `http://localhost:8081`, `CLIENT_SUCCESS_URL=http://localhost:8081`,
`CORS_ORIGINS=http://localhost:8081`. Restart the API after `.env` changes (`nest --watch` does not reload env).

## Login split (first-party wallet vs public flow)

- Wallet (`apps/wallet`) uses `sdk-js` direct calls + `pid-core`/`pid-solana`
  primitives only — never `pid-react` / hosted login (CI guard in `ci.yml` fails
  the build otherwise).
- Dev and prod run the identical OAuth code path; only credentials differ
  (`NODE_ENV=production` selects `GOOGLE_*_PROD`, otherwise `GOOGLE_*_DEV`).
  Never point local dev at the prod callback and never add localhost URIs to the
  prod Google client — create a dev client instead.
- Only `pid-core` (primitives) and `pid-solana` (chain adapter) may import
  `@solana/web3.js` (ADR 007 §8, CI-enforced).

## Verification

- API: `pnpm --filter @peridotvault/pid-api exec jest` (178 tests).
- Program: `cargo test` (12) + `tests/integration.mjs` (13 cases) against the local
  validator; devnet E2E `packages/sdk-js/test/devnet.e2e.mjs`.
- Full: `pnpm typecheck`.

## Notes

- The Secp256r1 precompile enforces low-S and does not simulate correctly — send with
  `skipPreflight`; expiries use the chain clock (`Clock` sysvar), not the device clock.
- `sol_sha256` syscall crashes this SBF toolchain — the program uses pure-Rust SHA-256
  (`src/sha256.rs`).