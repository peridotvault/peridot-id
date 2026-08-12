# 011 — Wallet SDK Surface + Fee Payer Client

## Status

planned

## Objective

Extend `packages/sdk-js` with the PRD_v4 §17 wallet surface — `connect`, `auth.login`,
`wallet.get`, `wallet.send`, status polling — and the client-side key/credential management
(fee payer generation/storage, signing ceremony) that makes the DX snippet real.

## Why

PRD_v4 §30 Definition of Done is a code snippet; this task makes it executable. §17 lists
what the SDK must hide (serialization, RPC, PDA derivation, authority details, blockhash,
polling, instruction encoding) and §8.3 requires the fee payer to be invisible to apps.

## PRD References

- §8.3 (fee payer abstraction), §17 (SDK), §18 (frontend components), §29 Phase 5,
  §30 (Definition of Done)

## Repository Context

- `packages/sdk-js` is a thin fetch client today — this task adds a wallet sub-client while
  keeping the package browser-safe.
- Fee payer: generated client-side, stored in non-extractable WebCrypto where practical
  (ADR 006 §2); address registered via API into `wallet_fee_payers`.
- No `apps/web` exists in the repo — React components (§18) are deferred until a consuming
  app exists; this task ships the headless SDK only.
- Backend endpoints come from 004/005/009; chain mechanics from 010.

## Scope

- `Peridot.connect({ clientId })` → `auth.login()` (existing OAuth redirect flow),
  `wallet.get()` (account + chain accounts + addresses), `wallet.send({ chain, action })`
  for `TRANSFER_SOL`, `getTransactionStatus(signature)`.
- Client key management: fee-payer generation, secure storage, per-device registration;
  credential ceremony client (WebAuthn or Ed25519 per ADR 005) calling 005's endpoints.
- Insufficient-fee-SOL error surfaced as a first-class typed error (PRD_v4 §14 honesty).
- Debugging/audit surface (§17): transaction ids, intent ids, and status are inspectable.

## Out of Scope

- React/UI components (`<PeridotProvider />` etc.) — deferred until `apps/web` or a
  consuming app exists (recorded here so §18 is not silently dropped).
- Multi-chain SDK surface (solana only in V1).
- Sponsorship or fee abstraction (forbidden).

## Dependencies

- 004 (accounts API), 005 (credentials API), 009 (intents), 010 (adapter/signer interface).

## Acceptance Criteria

- The §30 snippet runs against devnet (used verbatim by 012's E2E).
- Fee payer is generated/stored client-side; the server never receives secret material
  (verified by request inspection in tests).
- App code never touches serialization, RPC URLs, PDA derivation, or blockhashes.
- Typed errors: insufficient fee SOL, credential required, intent expired.

## Security Considerations

- XSS/malicious-extension exposure (§23.4/5) is documented: the fee-payer key is
  non-extractable where the platform allows; the authority credential per ADR 005.
- The SDK validates server-provided payloads against its own derivation (defense against a
  compromised API feeding substituted transactions — §23.10).
