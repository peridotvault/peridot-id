# 005 — Signing Authority: Credential Registration & Lifecycle API

## Status

planned — **blocked until ADR 005 is stakeholder-accepted** (A = Ed25519, B = secp256r1
passkey)

## Objective

Implement the credential lifecycle API (PRD_v4 §16): registration, authentication
ceremonies, listing, and revocation of signing authorities, persisting public material into
`authorities`.

## Why

PRD_v4 §8: OAuth proves identity; a cryptographic authority authorizes. This task builds the
off-chain half of that authority — the on-chain verification lands in 007. PRD_v4 §10
requires multiple credentials, revocation, and rotation as V1 features.

## PRD References

- §8 (authorization), §9 (client/server secret split), §10 (multi-device), §16 (Credentials
  API), §22 (credential registration authentication, revocation), §27 (credential lifecycle
  unit tests), §28 (Authorization), §29 Phase 3

## Repository Context

- `authorities` table from 003 (`type`, `public_key`, `credential_id`, `status`,
  `last_used_at`).
- If ADR 005 = B: WebAuthn server library (e.g. `@simplewebauthn/server`) — a new dependency
  requiring the ADR-level justification already given in ADR 005; RP ID/origin config via env.
- If ADR 005 = A: Ed25519 challenge-response registration (sign a server nonce with the
  device key) using `@noble/curves` or web3.js already pulled by `packages/solana`.
- Credential ceremony routes sit behind `JwtAuthGuard`; adding a credential to an account
  with existing authorities requires approval by an existing credential (ADR 006 §4).

## Scope

- Endpoints per PRD_v4 §16: `POST /v1/credentials/register/start`,
  `POST /v1/credentials/register/finish`, `POST /v1/credentials/authenticate/start`,
  `POST /v1/credentials/authenticate/finish`, `DELETE /v1/credentials/:id`,
  `GET /v1/credentials`.
- Only the winning ADR 005 model is implemented (YAGNI — no dual-stack).
- Last-authority guard: revocation that would leave the account with zero valid authorities
  is rejected (mirrors the identity last-credential guard; ADR 006 §5).
- `security_events` for register/authenticate/revoke, including failure paths.
- OpenAPI/types/SDK updates.

## Out of Scope

- On-chain authority storage/verification (task 007) and rotation execution (on-chain half;
  task 006 orchestrates).
- Recovery UX flows (task 006).
- Encrypted server-side key backup (forbidden — ADR 006).

## Dependencies

- 001 (ADR 005 accepted), 003 (`authorities`), 004 (accounts).

## Acceptance Criteria

- Full ceremony round-trip against a real authenticator (B) or real Ed25519 key (A) in
  integration tests.
- Server stores public key + credential id only — DB dump contains nothing that can sign.
- Second credential can be added with existing-credential approval; revocation updates
  status and `last_used_at` tracking works.
- OAuth-session-only attempts to add a credential (no existing-credential approval when one
  exists) are rejected (PRD_v4 §10).
- Replay of a ceremony challenge is rejected (single-use, expiring challenges).

## Security Considerations

- Strict origin/RP validation (PRD_v4 §22); challenge TTL ≤ 5 min, single use.
- Registration requires an authenticated session (PRD_v4 §22 "credential registration
  authentication").
- Nothing secret in logs (ADR 006 §6).
