# 007 — Anchor Smart Account Program

## Status

planned — **blocked until ADR 005 is stakeholder-accepted** (verification path depends on
the authority model)

## Objective

Implement `programs/peridot-smart-account` per ADR 007: initialize, execute, update_authority,
close — with nonce replay protection, domain-separated actions, controlled CPI, and events.

## Why

PRD_v4 §11/§24: the program is the on-chain enforcement point. Everything else (OAuth,
sessions, policies) is off-chain advisory; the program is what makes "compromised API cannot
steal assets" true (PRD_v4 §23).

## PRD References

- §7 (Solana account architecture), §11 (program), §24 (security rules), §25 (domain
  separation), §26 (events), §29 Phase 4, §32 (no mock authorization)

## Repository Context

- No Rust/Anchor workspace yet — this task creates `programs/peridot-smart-account/`
  (Anchor.toml, Cargo.toml, src/{lib,state,errors}.rs, src/instructions/*).
- Anchor toolchain + `solana-test-validator` for local development (docker-compose or
  documented local install — decide in this task, document in README).
- Authority field sizing per ADR 005 (32 B vs 33/64 B + 1-byte model tag — ADR 007 §2).

## Scope

- State account: `account_id [u8;32]`, tagged `authority`, `status`, `nonce u64`,
  `version u8` (ADR 007 §2).
- `initialize` / `execute` / `update_authority` / `close` per ADR 007 §3, including the
  full §24 checklist: authority verification, exact-message binding, PDA/seed validation,
  target program/account validation, nonce increment, events.
- Controlled CPI: System Program SOL transfer only (allowlist); no arbitrary CPI.
- Domain-separated action encoding: `PERIDOT|SOLANA|SMART_ACCOUNT|v1` + fields (PRD_v4 §25).
- If ADR 005 = B: secp256r1 precompile verification via instruction introspection, WebAuthn
  challenge bound to the action payload. If A: Ed25519 verification path.

## Out of Scope

- SPL token transfers (only if the allowlist mechanism absorbs them cleanly — PRD_v4 §28;
  otherwise a follow-up task).
- Program test suite and devnet deploy (task 008).
- Gas sponsorship of any kind (forbidden — PRD_v4 §14).

## Dependencies

- 001 (ADRs 004/005/007). Blocks 008, 010.

## Acceptance Criteria

- `anchor build` succeeds; IDL generated and checked in.
- The PRD_v4 §24 rules are all implemented and each maps to at least one test in 008.
- No placeholder/always-true authorization anywhere in non-test code (§32).
- Authority storage matches the ADR 005 model exactly (no 32-byte hardcode under B).

## Security Considerations

- This task *is* the on-chain security boundary. Review checklist = PRD_v4 §24 verbatim.
- Upgrade authority at local/devnet stage may be the dev keypair; custody hardens in 008/013.
