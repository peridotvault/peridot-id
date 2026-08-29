# 010 — Expo Wallet Client (web + iOS + Android)

## Status

implemented (2026-08-28) — one Expo codebase for web + iOS + Android, wired to the SDK.
Web bundle verified (`expo export --platform web`). Run with `pnpm dev:web`.

## Delivered (`apps/wallet`)

- Single codebase (Expo SDK 57, React Native 0.81) targeting web (react-native-web),
  iOS, Android — no separate website (PRD_v5 §9).
- Screens: **Login** (Google OAuth via the SDK), **Home** (auto-creates the Peridot account,
  shows the deterministic smart-account address + balance), **Top Up** (first top-up
  initializes the account in the same tx), **Tarik/Withdraw** (passkey-authorized),
  **Passkey** (register/list credentials).
- Uses `@peridot/sdk-js` (`Peridot`, `PeridotWallet`, `PeridotPasskey`); no chain/PDA logic
  in the app. Config via `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_SOLANA_RPC_URL`.
- Fee payer uses the SDK's default in-memory store — swap to Expo SecureStore (mobile) /
  WebCrypto non-extractable (web) for production via the SDK `SecretStore`.

## How to run

```sh
pnpm install
cd apps/wallet
pnpm dev:web          # web; `pnpm dev` for iOS/Android via Expo Go
```

Prereqs: `apps/api` running locally (Postgres up, `pnpm dev`), the Peridot program deployed
to the local validator (task 004) or devnet, and a Google OAuth test app with
`CLIENT_SUCCESS_URL` pointing at the Expo web origin.

## Out of Scope

- Chrome extension (post-V1; thin shell over `packages/sdk-js`).
- Desktop-native app (YAGNI, PRD_v5 §9).
- Platform secure-storage hardening (Expo SecureStore) — production pass, task 012.

## Objective

Build `apps/wallet` — the single Expo client (React Native + Expo web) that serves as the
PeridotID wallet UI on web and mobile from one codebase (PRD_v5 §9), consuming
`packages/sdk-js` (task 009).

## Why

PRD_v5 §9: no separate website — one Expo codebase covers web and mobile. This is the
user-facing surface for the whole PRD_v5 flow: Google login → top-up (first top-up
initializes the Smart Account) → balances → passkey-authorized withdraw.

## PRD References

- PRD_v5 §3 (flows), §6 (authorization, multi-device), §7 (bootstrap), §9 (client), §10
  (V1), §12 (success criteria); PRD_v4 §18 (components)

## Repository Context

- `apps/` currently holds `api` and `docs` only — this task creates `apps/wallet`
  (Expo workspace member; follow `pnpm-workspace.yaml` conventions).
- SDK sub-clients (`auth`, `identity`, `profile`, `wallet`) come from
  `packages/sdk-js` (task 009). This app contains **no** chain/PDA/ATA logic.
- Passkeys: WebAuthn API on Expo web; React Native passkey module on iOS/Android
  (PRD_v5 §9 adapter table). Fee-payer storage: WebCrypto (web) / Expo SecureStore
  (native).

## Scope

- Expo app skeleton running on web + iOS + Android from one codebase.
- Screens: Google login (OAuth via the existing API flow), wallet home (Smart Account
  address, SOL/SPL balances), top-up, withdraw (passkey ceremony), transaction status.
- Platform adapters wiring: passkey + secure storage per PRD_v5 §9 table.
- UX copy (Indonesian, per convention): second-credential prompt, fee-payer funding
  address shown pre-activation (PRD_v5 §7), insufficient-fee-SOL error,
  all-credentials-lost warning (ADR 006 §5).
- Reusable components per PRD_v4 §18 (`<PeridotProvider />`, login, wallet, transaction
  confirm) — as Expo/React Native components shared across all three targets.

## Out of Scope

- Chrome extension (post-V1; thin shell over `packages/sdk-js`).
- Desktop-native app (Tauri or otherwise — YAGNI, PRD_v5 §9).
- Any key custody or signing on the server (forbidden — ADR 006).

## Dependencies

- 009 (headless wallet SDK). Feeds 011 (E2E).

## Acceptance Criteria

- `pnpm dev` runs the app on web and at least one mobile target from the same code.
- Google login → first top-up initializes Smart Account → balance visible → SPL deposit
  auto-creates ATA → passkey-authorized withdrawal succeeds (verified fully in 011).
- Same Google account on a second device reaches the same wallet (PRD_v5 §6
  multi-device).
- No seed phrase screen, no private-key UI, no external wallet dependency.

## Security Considerations

- The app never sends key material anywhere; passkey secrets stay in the authenticator,
  fee-payer secrets in platform secure storage (ADR 006).
- OAuth session cookies/tokens are device-local; a fresh login never grants signing
  authority without a registered passkey (PRD_v5 §6).
