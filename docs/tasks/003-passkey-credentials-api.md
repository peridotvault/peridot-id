# 003 — Passkey Credential Registration & Lifecycle API

## Status

planned

## Objective

Implement the credential lifecycle API (PRD_v4 §16): registration, authentication
ceremonies, listing, and revocation of signing authorities, persisting public material into
`authorities`. Model: **secp256r1 passkey (WebAuthn) only** — ADR 005 Option B, accepted.

## Why

PRD_v5 §6: Google OAuth proves identity; the passkey authorizes the wallet. This task
builds the off-chain half of that authority — on-chain verification lands in task 004.
PRD_v5 §6 multi-device requires multiple credentials, revocation, and rotation as V1
features.

## PRD References

- PRD_v5 §6 (authorization, multi-device); PRD_v4 §8, §9 (client/server secret split),
  §10 (multi-device), §16 (Credentials API), §22 (credential registration authentication),
  §27 (credential lifecycle unit tests), §28 (Authorization)

## Repository Context

- `authorities` table from 001 (`type`, `public_key`, `credential_id`, `status`,
  `last_used_at`) — `type = secp256r1` only.
- WebAuthn server library (e.g. `@simplewebauthn/server`) — new dependency, justified by
  ADR 005; RP ID/origin config via env.
- Credential ceremony routes sit behind `JwtAuthGuard`; adding a credential to an account
  with existing authorities requires approval by an existing credential (ADR 006 §4) —
  this is what makes "Google login alone never grants signing authority" true (PRD_v5 §6).

## Scope

- Endpoints per PRD_v4 §16: `POST /v1/credentials/register/start`,
  `POST /v1/credentials/register/finish`, `POST /v1/credentials/authenticate/start`,
  `POST /v1/credentials/authenticate/finish`, `DELETE /v1/credentials/:id`,
  `GET /v1/credentials`.
- WebAuthn/secp256r1 only — no Ed25519 authority path (YAGNI — no dual-stack; ADR 005).
- Last-authority guard: revocation that would leave the account with zero valid authorities
  is rejected (mirrors the identity last-credential guard; ADR 006 §5).
- `security_events` for register/authenticate/revoke, including failure paths.
- OpenAPI/types/SDK updates.

## Out of Scope

- On-chain authority storage/verification (task 004) and rotation execution (on-chain half;
  task 008 orchestrates).
- Recovery UX flows (task 008).
- Encrypted server-side key backup (forbidden — ADR 006).

## Dependencies

- 001 (`authorities`), 002 (accounts).

## Acceptance Criteria

- Full WebAuthn ceremony round-trip against a real authenticator in integration tests.
- Server stores public key + credential id only — DB dump contains nothing that can sign.
- Second credential can be added with existing-credential approval; revocation updates
  status and `last_used_at` tracking works.
- OAuth-session-only attempts to add a credential (no existing-credential approval when one
  exists) are rejected (PRD_v5 §6).
- Replay of a ceremony challenge is rejected (single-use, expiring challenges).

## Security Considerations

- Strict origin/RP validation (PRD_v4 §22); challenge TTL ≤ 5 min, single use.
- Registration requires an authenticated session (PRD_v4 §22 "credential registration
  authentication").
- Nothing secret in logs (ADR 006 §6).
