# 004 — Smart Account Program (Pinocchio)

## Status

implemented (local validator) — **secp256r1 passkey authority (ADR 005 Option B, Tier B)**.
A transient Ed25519 fallback was reconsidered and reverted when the
`pinocchio-secp256r1-instruction` crate (vendored + adapted for pinocchio 0.10) enabled the
Secp256r1 precompile introspection pattern via pinocchio's `Instructions` sysvar. Full
adversarial suite + devnet deploy are task 005.

## Verification design (what the program enforces)

The wallet authority is a WebAuthn passkey (secp256r1). Its assertion signature covers
`authenticatorData ‖ sha256(clientDataJSON)`; the SDK places a Secp256r1 precompile
instruction immediately after the program instruction, and the program introspects it via
the Instructions sysvar to verify:

1. the recovered 33-byte compressed public key equals `state.authority` (the passkey owns
   the account);
2. the signed message's last 32 bytes equal `sha256(clientDataJSON)` where clientDataJSON
   is a program argument (binds the exact attested bytes);
3. the `"challenge"` inside clientDataJSON decodes to the domain-separated authorization
   payload `sha256(DOMAIN ‖ nonce ‖ action ‖ expiry)` recomputed from the program's own
   arguments — blocks transaction substitution;
4. `expiry >= Clock::get().unix_timestamp` and `nonce == state.nonce` — replay protection.

The program then executes the transfer / authority rotation / close and increments the
nonce. `withdraw_sol` moves lamports directly (a System Program CPI transfer is forbidden
when `from` carries data). SHA-256 is a pure-Rust implementation (`src/sha256.rs`); the
`sol_sha256` syscall crashed this SBF toolchain.

**Verified (smoke test against `solana-test-validator`):** valid passkey withdraw succeeds
(nonce 0→1); wrong passkey pubkey, replayed nonce, expired expiry, challenge/args mismatch
(transaction substitution), and destination mismatch are all rejected.

## Objective

Implement `programs/peridot-smart-account` per ADR 007 (as amended): initialize,
withdraw_sol, withdraw_token, update_authority, close — with nonce replay protection,
domain-separated actions, controlled CPI, and events. No deposit instructions: deposits
are plain transfers (PRD_v5 §4).

## Why

PRD_v4 §11/§24: the program is the on-chain enforcement point. Everything else (OAuth,
sessions, policies) is off-chain advisory; the program is what makes "compromised API cannot
steal assets" true (PRD_v4 §23, PRD_v5 §8).

## PRD References

- PRD_v5 §5 (program), §6 (passkey authorization); PRD_v4 §7 (Solana account
  architecture), §24 (security rules), §25 (domain separation), §26 (events), §32 (no mock
  authorization)

## Repository Context

- No Rust workspace yet — this task creates `programs/peridot-smart-account/`
  (plain Cargo, Pinocchio; src/{lib,state,errors}.rs, src/instructions/* — ADR 007 §1).
- Solana toolchain + `solana-test-validator` for local development (docker-compose or
  documented local install — decide in this task, document in README).
- Authority field: secp256r1 (33/64 B + 1-byte model tag — ADR 005 accepted, ADR 007 §2).

## Scope

- State account: `account_id [u8;32]`, tagged `authority`, `status`, `nonce u64`,
  `version u8` (ADR 007 §2).
- `initialize` / `withdraw_sol` / `withdraw_token` / `update_authority` / `close` per
  ADR 007 §3, including the full PRD_v4 §24 checklist: authority verification,
  exact-message binding, PDA/seed validation, target program/account validation, nonce
  increment, events.
- secp256r1 precompile verification via instruction introspection, WebAuthn challenge
  bound to the action payload (ADR 005 Option B — accepted).
- Controlled CPI: System Program SOL transfer + Token Program SPL transfer only
  (allowlist); no arbitrary CPI.
- Domain-separated action encoding: `PERIDOT|SOLANA|SMART_ACCOUNT|v1` + fields (PRD_v4 §25).

## Out of Scope

- Deposit/top-up program instructions — deposits are plain transfers + idempotent ATA
  creation, built by `packages/solana` (task 006), not the program (PRD_v5 §4).
- Program test suite and devnet deploy (task 005).
- Gas sponsorship of any kind (forbidden — PRD_v4 §14).

## Dependencies

- None (ADRs 004–007 all accepted). Blocks 005, 006.

## Acceptance Criteria

- Program builds with `cargo build-sbf` (or the documented Pinocchio toolchain) and
  deploys to `solana-test-validator`.
- The PRD_v4 §24 rules are all implemented and each maps to at least one test in 005.
- No placeholder/always-true authorization anywhere in non-test code (§32).
- Authority storage matches ADR 005 Option B (secp256r1 — no 32-byte hardcode).

## Security Considerations

- This task *is* the on-chain security boundary. Review checklist = PRD_v4 §24 verbatim.
- Upgrade authority at local/devnet stage may be the dev keypair; custody hardens in 005/012.
