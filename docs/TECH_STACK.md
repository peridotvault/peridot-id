# Tech Stack
- NestJS
- PostgreSQL (Supabase compatible)
- Prisma
- JWT
- Passport Google OAuth
- Docker
- OpenAPI
- TypeScript
- Vercel (serverless) for deployment
- Solana program: Rust + Pinocchio (`contracts/svm/smart-account`, ADR 007)
- Solana client: `@solana/web3.js` in `packages/solana` only (ADR 007 §8)
- Signing: secp256r1 passkey authority (WebAuthn) + Ed25519 device fee payer (ADR 005/006)
- EVM (V4, ADR 009): Solidity `PeridotAccount` + `PeridotPermissionExecutor`
  (constrained ERC-7579, owner-only ERC-1271, scoped P-256 session keys);
  `packages/evm` adapter + `packages/core` permission builders; `v1/permissions` API
- Client: Expo (one codebase → web + iOS + Android, PRD_v5 §9); Chrome extension later over the sdk-js core
