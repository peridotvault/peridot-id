# Architecture

```text
Clients (Expo web/iOS/Android) -> SDK (@antigane/sdk-js) -> PeridotID API -> PostgreSQL
                                  |
                                  +-> Solana adapter (@antigane/solana) -> Solana RPC(s)
                                        |
                                        +-> Peridot smart-account program (Pinocchio, PDA)
```

Refresh-token state lives in the `sessions` table — PostgreSQL is the only datastore.

Modules:
- auth
- identity
- profile
- account (Peridot accounts + chain accounts, deterministic smart-account PDA)
- credentials (secp256r1 passkey registration/lifecycle)
- intent (withdrawal intents + policy)
- wallet (deprecated V3 record-only surface)

Non-custodial wallet model (ADR 004–007):
- Smart Account = a program PDA seeded `["peridot_id","account",account_id]`; authority is the
  user's secp256r1 passkey, verified on-chain via the Secp256r1 precompile + instruction
  introspection (ADR 005 Option B).
- Fee payer = client-held Ed25519 keypair (ADR 006). The server holds no key material.

Repo:
```
apps/api      NestJS (auth, identity, profile, account, credentials, intent, wallet)
apps/docs     Fumadocs
apps/wallet   Expo wallet client (web + iOS + Android, PRD_v5 §9)
programs/peridot-smart-account   Pinocchio smart-account program
packages/openapi / types / sdk-js / solana
```

Environments: local (solana-test-validator) · devnet (staging) · mainnet (production).
`packages/solana` is the only package allowed to import `@solana/web3.js` (ADR 007 §8).