# ADR 010 — SVM Session Layer (PDA-isolated gameplay sessions)

Status: accepted (SVM-only; pre-audit engineering — see §7).

Amends for SVM: the AA/session-keys deferral and the PRD_v4
§1.2/§5.5/§31 + PRD_v5 §10 deferrals, for gameplay sessions only. ADR 009
(EVM permission layer) is the sibling, not the template: nothing is ported —
the designs share vocabulary, never code, keys, nonces, or trust assumptions
(`contracts/WHITEPAPER.md` §12).

## Context

V3 gives one P-256 passkey total authority, with `execute` (disc 6) passing
the value-holding vault PDA as CPI signer to arbitrary targets. Any session
model reusing that shape would hand the session vault power. The Solana
account/CPI model additionally forces the issue: privileges extend
caller→callee per instruction with signer pass-through (runtime-proven), the
P-256 precompile is instruction-data-only (never per-action affordable at
~42M-CU sBPF cost), and `remaining_accounts` are unchecked by construction
(Anchor docs; Neodyme ND-SQD1-M1 substitution precedent).

## Decision

1. **Strict PDA signer isolation.** New session PDA
   (`["peridot_id","session",account_id,session_pubkey]`, 205B record) is the
   sole signer for gameplay CPIs; the vault PDA never appears in them. The
   session PDA holds exactly the rent-exempt minimum (program-created,
   owner-reclaimed). One session pubkey ⇒ one PDA (Asymmetric "one account,
   one permission").
2. **Ed25519 session keys.** Owner P-256 ceremony once (precompile, 0 CU);
   gameplay authorized by envelope signature + on-chain record (status, 24h
   hard expiry, 30min inactivity on the chain clock, strict per-session `seq`).
3. **Single-CPI scope with exact accounts.** No `remaining_accounts` (exact
   count enforced); ≥1 session-signer meta naming the session PDA; self-call
   blocked; vault address derived on-chain and rejected everywhere.
4. **Bounded protected accounts** (≤8, explicit subset of metas): pre/post
   lamport/owner/data-hash pin plus explicit delegate/close_authority compare
   for token-owned accounts. Defense-in-depth only — isolation is the guarantee.
5. **Upgrade visibility without enforcement (owner-accepted).** Loader classes:
   upgradeable programs get verified ProgramData snapshots at registration
   with per-execution `last_seen_*` refresh for indexers; native/deprecated
   programs are immutable by construction; unknown loaders fail closed.
   Post-registration upgrades keep session scope, visibly.
6. **State-based lifecycle.** Owner-signed register/revoke/close consume the
   owner nonce; revoke is immediate without session cooperation; close needs
   revoked-or-expired plus an owner-bound destination.

## Consequences

- Four new discriminators (7–10), new `PID|SOLANA|SESSION|v1` domain, new
  errors 17–22; existing 7 instructions, 112B state, and fee model untouched.
- Gameplay pays its own fees (no relayer split on session paths); registration
  rent is relayer-floated, owner-reclaimed.
- Session SOL is structurally immobile (system program debits only data-less
  accounts — runtime rule); the honest forwarding residual is session-owned
  tokens, containable per-session via protected listing.
- Any program change exercises the still-unsecured upgrade authority (task 012
  open) — unchanged posture, wider blast radius until secured.

## §7. Pre-audit status (blocking mainnet/immutability)

Proven (27 host unit + 24 validator session + 37 existing integration tests,
SDK/backend specs): §5-table guarantees for single-CPI scope, domain
disjointness, revocation immediacy, rent-exact lifecycle, loader classes,
SDK↔program byte parity via independent reimplementation. Claim only:
Token-2022 extensions beyond base authority fields, hostile-CPI griefing
bounds, upgrade-visibility sufficiency, inactivity adequacy, indexer coverage.
External human audit required before mainnet or authority burn.

## References

- `contracts/WHITEPAPER.md` §11 (canonical), `contracts/svm/smart-account/src/`
  (`state.rs`, `programdata.rs`, `instructions/{register_session,
  session_execute,revoke_session,close_session}.rs`),
  `contracts/svm/mock-forwarder/` (adversarial helper, localnet-only),
  `tests/session.mjs`.
- solana.com/docs/core/cpi (privilege rules), SIMD-0075 + precompiles/fee docs,
  Asymmetric Research "Invocation Security" (2025-04-23), Neodyme Squads v4
  ND-SQD1-M1, Anchor `remaining_accounts` docs, Token/Token-2022 instruction
  source, loader_upgradeable source.
- WHITEPAPER.md §§1, 11–12 (scope, executor constraint, one wallet with inside-scoping), ADR-009 (EVM sibling).
