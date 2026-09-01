# 009 — Wallet SDK + Fee Payer Client

## Status

implemented (2026-08-28) — SDK wallet surface + passkey signing + fee payer, verified
end-to-end against a local validator.

## Delivered (`packages/sdk-js`)

- **`PeridotWallet`**: `me()` (default account + smart-account address), `topup({amount, asset})`
  (first SOL top-up composes initialize+deposit in one tx via `initializeAndDepositSol`),
  `withdraw({amount, asset, to})` (passkey-authorized), `getTransactionStatus(signature)`,
  `getBalance()`.
- **`BrowserPasskeySigner`**: `navigator.credentials.get` WebAuthn → DER→raw ECDSA
  signature + authenticatorData + clientDataJSON, ready for the adapter.
- **`registerPasskey`**: drives the task-003 ceremony (create + existing-credential approval).
- **`PeridotPasskey`**: list/register/revoke credentials.
- **`FeePayerManager` + `SecretStore`**: client-held Ed25519 fee payer (ADR 006 §2),
  generated once and persisted in injectable secure storage (WebCrypto/keystore/Expo
  SecureStore in task 010; in-memory default).

## Cross-package change

`@peridotvault/pid-solana` was made **browser-safe**: no Buffer/node:crypto — a pure `bytes.ts`
(Uint8Array helpers, WebCrypto SHA-256, DER→raw, low-S) and async payload builders.
Confirmed no regression via the adapter e2e.

## Verification

`test/wallet.e2e.mjs` (run with `tsx` against a local validator + mock API/passkey):
topup (first top-up initializes the smart account) → balance 11.4M → passkey-signed
withdraw confirmed → ~36.4k CU. Full `pnpm typecheck` green.

## Objective

Extend `packages/sdk-js` (or its wallet sub-client) into the wallet SDK surface of PRD_v5
§9: auth (existing), wallet state, top-up, withdraw, transaction status — plus the
client-side fee-payer and passkey ceremony machinery.

## Why

PRD_v5 §9: developers call `peridot.wallet.topup()` / `withdraw()` and never touch PDA
derivation, ATA creation, precompile introspection, blockhash management, or confirmation
polling. PRD_v4 §30 Definition of Done is this SDK's call shape.

## PRD References

- PRD_v5 §9 (SDK + developer experience); PRD_v4 §8.3 (fee payer abstraction), §14 (fee
  honesty), §17 (SDK), §30 (Definition of Done)

## Repository Context

- `packages/sdk-js` is a thin fetch client today — this task adds the wallet sub-client
  while keeping the package platform-agnostic (browser + Expo + future extension).
- Fee payer: generated client-side, stored in non-extractable WebCrypto where practical
  (ADR 006 §2); address registered via API into `wallet_fee_payers`.
- The consuming client is `apps/wallet` (Expo, web + iOS + Android — task 010,
  PRD_v5 §9); this task ships the headless SDK only.
- Backend endpoints come from 002/003/007; chain mechanics from 006.

## Scope

- `peridot.wallet.me()` (account + chain accounts + addresses),
  `peridot.wallet.topup({ amount, asset })` (deposit tx built by 006: plain transfer +
  idempotent ATA; first top-up composes initialize + deposit, PRD_v5 §3),
  `peridot.wallet.withdraw({ amount, asset, to })` (intent → passkey ceremony → submit
  via 007/006), `getTransactionStatus(signature)`.
- Client key management: fee-payer generation, secure storage, per-device registration.
- Passkey ceremony client (WebAuthn — ADR 005 Option B) calling 003's endpoints.
- Insufficient-fee-SOL error surfaced as a first-class typed error (PRD_v4 §14 honesty).
- Debugging/audit surface (§17): transaction ids, intent ids, and status are inspectable.

## Out of Scope

- UI components — ship in the Expo client, task 010.
- Multi-chain SDK surface (solana only in V1).
- Sponsorship or fee abstraction (forbidden).

## Dependencies

- 002 (accounts API), 003 (credentials API), 006 (adapter/signer interface),
  007 (intents). Blocks 010.

## Acceptance Criteria

- The PRD_v5 §9 snippets (`topup`, `withdraw`) run against a local validator-backed API in
  integration tests.
- First `topup` on a fresh account initializes the Smart Account in the same transaction;
  subsequent top-ups do not re-initialize.
- SPL top-up to a fresh account creates the ATA on demand.
- Fee-payer secret never leaves the client; server sees only its address.
- Typed insufficient-fee error; status polling reaches `confirmed`.

## Security Considerations

- SDK stores/handles secrets only in platform secure storage; nothing secret in logs or
  error payloads (ADR 006 §6).
- The SDK cannot sign without the user's passkey ceremony — no silent-signing path (§22
  Critical).
