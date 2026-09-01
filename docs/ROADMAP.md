# Roadmap

## Foundation (V1 — implemented)
Authentication, Identity, Profile, Wallet
- Google OAuth login, PID identity, profile
- Non-custodial Solana smart account (Pinocchio program) — secp256r1 passkey authority
- Passkey credential lifecycle + recovery/multi-device (task 003/008)
- Solana adapter + RPC failover (`packages/solana`)
- Withdrawal intents + policy (task 007)
- Wallet SDK + fee-payer client (`@peridotvault/pid-sdk-js`)
- Expo wallet client (web + iOS + Android)
- Devnet E2E verified (task 011)

## Production (V1 gate — stakeholder)
Mainnet deployment, external audit, upgrade-authority custody (task 012 runbook)

## Social
Friends, Presence, Notifications

## Gaming
Inventory, Achievements, Cloud Save

## Wallet (post-V1)
- Chrome extension (thin shell over the SDK)
- Passkey-authority refinement as Pinocchio introspection matures
- Gas sponsorship, session keys, guardians, EVM smart accounts (PRD_v4 §31)

## Ecosystem
Partner SDKs, Developer Portal