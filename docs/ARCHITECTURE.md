# Architecture

```text
Clients (Expo web/iOS/Android) -> SDK (@peridotvault/pid-sdk-js) -> PeridotID API -> PostgreSQL
                                  |
                                  +-> Solana adapter (@peridotvault/pid-solana) -> Solana RPC(s)
                                  |     |
                                  |     +-> Peridot smart-account program (Pinocchio, PDA)
                                  |
                                  +-> EVM adapter (@peridotvault/pid-evm) -> EVM RPC(s)
                                        |
                                        +-> PeridotAccount + PeridotPermissionExecutor
                                            (Solidity, CREATE2; V4 scoped permissions, ADR 009)
```

Refresh-token state lives in the `sessions` table — PostgreSQL is the only datastore.
(On-chain V4 **session keys** are unrelated to this table; see DATABASE.md.)

Modules:
- auth
- identity
- profile
- account (Peridot accounts + chain accounts, deterministic smart-account PDA / CREATE2)
- credentials (secp256r1 passkey registration/lifecycle)
- intent (withdrawal intents + policy)
- permissions (EVM grant validation + denied selectors, ADR 009)
- wallet (deprecated V3 record-only surface)

Non-custodial wallet model (ADR 004–007, 009):
- Smart Account = a program PDA seeded `["peridot_id","account",sha256(pid)]`; authority is the
  user's secp256r1 passkey, verified on-chain via the Secp256r1 precompile + instruction
  introspection (ADR 005 Option B).
- EVM counterpart = CREATE2 `PeridotAccount` (same passkey model, RIP-7212-style verify)
  with V4 scoped P-256 session keys + constrained ERC-7579 + owner-only ERC-1271 (ADR 009).
  Nothing in the permission layer ports to Solana (structurally different boundary).
- Fee payer = client-held Ed25519 keypair (ADR 006) on Solana; sponsored relayer on EVM.
  The server holds no key material.

Repo:
```
apps/api      NestJS (auth, identity, profile, account, credentials, intent, permissions, wallet)
apps/web      Fumadocs docs site
apps/wallet   Expo wallet client (web + iOS + Android, PRD_v5 §9)
contracts/svm/smart-account   Pinocchio smart-account program
contracts/evm                 Counterfactual smart accounts + permission executor (Solidity/Foundry)
packages/openapi / types / sdk-js / solana / evm / core
```

Environments: local (solana-test-validator) · devnet (staging) · mainnet (production).
`packages/solana` is the only package allowed to import `@solana/web3.js` (ADR 007 §8).