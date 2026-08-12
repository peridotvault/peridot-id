# 001 — V4 Architecture Lock: ADRs 004–007

## Status

planned

## Objective

Produce the Phase-0 deliverables of PRD_v4 (§29) — ACCOUNT_MODEL, AUTHORITY_MODEL,
WALLET_SECURITY_MODEL — as ADRs, and get the one open decision (authority model) resolved by
the stakeholder before any smart-account code is written.

## Why

PRD_v4 §29 Phase 0: "Do not write production smart-account code before these are resolved."
PRD_v4 §32: the agent must stop at security-critical design choices, document them, and
follow the PRD's constraints. This task is that stop.

## PRD References

- §7 (Solana account architecture), §8 (cryptographic authorization), §9 (wallet credential
  architecture), §10 (multi-device), §12 (authority verification options), §29 Phase 0,
  §32 (implementation rule)

## Repository Context

- ADR conventions: `docs/adr/NNN-kebab-title.md`, numbered continuing from 003.
- ADR 003 left an explicit escalation ("custody model must be chosen before signing") that
  the V4 ADRs resolve.
- Existing stack constraints the ADRs must respect: Vercel serverless, Postgres-only, browser
  SDK, REST/OpenAPI-first.

## Scope

- ADR 004 — account model (tables, PDA derivation, `wallets → chain_accounts` migration).
- ADR 005 — authority model: Ed25519 vs secp256r1/WebAuthn, with recommendation and explicit
  stakeholder sign-off.
- ADR 006 — wallet security & recovery (fee payer, credential storage, multi-device,
  recovery, threat-model answer).
- ADR 007 — Solana program & chain adapter architecture (Anchor, PDA, instructions, events,
  RPC abstraction).
- Present ADR 005's A/B choice to the stakeholder; record the verdict in ADR 005's Status.

## Out of Scope

- Any implementation (schema is 003, credentials are 005, program is 007).
- Vendor evaluations (RPC providers, multisig tooling) beyond what the ADRs need.

## Dependencies

None. Blocks every other V4 task (002–013).

## Acceptance Criteria

- All four ADRs exist and cross-reference each other and PRD_v4 sections.
- ADR 005 is either stakeholder-accepted (A or B chosen) or explicitly remains `proposed`,
  in which case tasks 005 and 007 stay blocked.
- Each ADR answers its Phase-0 questions from PRD_v4 §29 (what is the authority, how
  generated, where stored, second-device authorization, recovery, fee-payer management,
  on-chain verification).

## Security Considerations

This task *is* the security fork of V4: authority model, custody, fee-payer handling, and
upgrade-authority custody are all decided here. No code may bypass an unresolved ADR.
