# 008 — Program Tests + Devnet Deployment

## Status

planned

## Objective

Prove the program against PRD_v4 §27's Program Tests list on a local validator, then deploy
to devnet and record the program id.

## Why

PRD_v4 §29 Phase 4: "Deploy to local validator. Then devnet." §28 (Solana) requires
deployed-to-devnet with working init/authority/execution. §27 names the exact adversarial
test list.

## PRD References

- §27 (Program Tests, Unit Tests), §28 (Solana), §24 (rules under test), §29 Phase 4

## Repository Context

- `anchor test` with `solana-test-validator`; CI needs an Anchor/Rust job (new — document
  the toolchain versions in `programs/peridot-smart-account/README` or CI config).
- Devnet SOL via faucet for deployer; deployer keypair is CI/local-only, never committed.
- If ADR 005 = B: compute-budget and precompile verification cost must be measured here —
  this is the ADR 005 fallback checkpoint.

## Scope

- Program tests covering every §27 item: initialize, valid authorization, invalid
  authorization, invalid nonce, replay attack, unauthorized transfer, unauthorized CPI,
  authority rotation, malformed instruction, account mismatch.
- Unit tests for PDA derivation (shared vectors with task 004's off-chain derivation).
- Devnet deploy; record program id + deployer/upgrade authority in task output and
  `docs/` (no secrets — pubkeys only).
- (ADR 005 = B only) compute/report: verification fits in budget for a single-transfer
  execute; if not, escalate per ADR 005 fallback.

## Out of Scope

- Mainnet deploy and upgrade-authority hardening (task 013).
- Full E2E through the API/SDK (task 012).

## Dependencies

- 007 (program).

## Acceptance Criteria

- Every §27 Program Tests bullet passes locally in CI.
- Program deployed to devnet; program id recorded; `initialize` + a real `execute` SOL
  transfer succeed on devnet via script.
- (B only) compute-budget report attached; fallback escalated if blown.

## Security Considerations

- Deployer/upgrade key handling documented; no private keys in repo, CI logs, or env dumps.
- Devnet deploy uses a dedicated throwaway deployer; upgrade authority transfer to the
  stakeholder-held key is a 013 step.
