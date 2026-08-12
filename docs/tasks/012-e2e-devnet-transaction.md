# 012 — End-to-End Devnet Transaction

## Status

planned

## Objective

Prove the full PRD_v4 flow on devnet with a fresh user: OAuth login → Peridot account →
smart account → credential → funded fee payer → real SOL transfer → confirmation → re-login
sees the same wallet.

## Why

PRD_v4 §27 (E2E Test) and §30 (Definition of Done) define this exact scenario; §29 Phase 6
requires testing with real devnet SOL. This is the V1 integration gate before hardening.

## PRD References

- §3 (target UX), §13 (transaction flow), §14 (fee flow), §27 (Integration + E2E tests),
  §28 (all categories), §29 Phase 6, §30 (Definition of Done)

## Repository Context

- All upstream pieces: 002 (Discord), 004 (accounts), 005 (credentials), 006 (recovery),
  007/008 (program on devnet), 009 (intents), 010 (adapter), 011 (SDK).
- E2E harness: existing test setup + a headless browser flow (Playwright or documented
  script); devnet faucet for funding.
- Google OAuth E2E may use a test Google app; Discord optional in E2E if test-app friction
  is high (covered by 002's integration tests).

## Scope

- E2E scenario per §27's 10 steps: login; obtain wallet; see Solana smart account; receive
  SOL (faucet → fee payer); execute transaction; pay own fee; see confirmation; logout;
  login again; same account.
- The §30 developer snippet run verbatim against devnet.
- Negative paths: insufficient fee SOL fails honestly; OAuth-alone device cannot sign
  (006's guarantee, verified here end-to-end).
- Test report attached to the task (tx signatures, program id, network).

## Out of Scope

- Load/performance testing and mainnet anything (task 013).
- SPL tokens.

## Dependencies

- 002, 004, 005, 006, 008, 009, 010, 011 (everything upstream).

## Acceptance Criteria

- All 10 §27 E2E steps pass on devnet in CI or a documented reproducible script.
- Fee for the test transaction is paid by the user's fee payer, verifiable on-chain (the
  fee payer is the fee payer account in the tx).
- No sponsorship, treasury, or paymaster appears anywhere in the flow (§14).
- §28 Acceptance Criteria checklist is re-run and attached as the V1 scorecard.

## Security Considerations

- E2E doubles as the §23 spot-check: inspect that no response/log/analytics payload contains
  secret material during the whole flow.
