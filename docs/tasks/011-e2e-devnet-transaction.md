# 011 — End-to-End Devnet Transaction

## Status

implemented (2026-08-28) — full on-chain E2E against the real devnet program via the SDK.
The browser leg (Google OAuth + Playwright virtual authenticator) is documented below as a
follow-up requiring the stakeholder's Google test app.

## Devnet on-chain E2E (verified)

`packages/sdk-js/test/devnet.e2e.mjs` (run with `tsx` against
`https://api.devnet.solana.com`, program `CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT`):

- fee payer funded (devnet CLI wallet; faucet is rate-limited so it falls back to the CLI
  keypair);
- **first top-up** — `initializeAndDepositSol` initializes the smart account + deposits in
  one tx → confirmed;
- smart account balance reflects the deposit (11.4M lamports);
- **passkey-authorized withdrawal** → confirmed (~36,447 CU), destination receives the
  exact amount (verified on-chain);
- nonce increments; status polling returns confirmed.

## Browser E2E (follow-up — needs your Google test app)

The remaining leg is a headless-browser flow through `apps/wallet` on devnet:
Playwright with a **virtual authenticator** (CDP `WebAuthn` protocol) for the passkey
ceremony + your Google OAuth test app (`CLIENT_SUCCESS_URL` = the Expo web origin).
Scenario (PRD_v5 §12): Google login → see the smart-account address pre-activation → fund
fee payer → first top-up initializes → SPL deposit (auto-ATA) → passkey withdrawal → re-login
on a second profile sees the same account. Negative paths: insufficient fee-payer SOL fails
honestly; OAuth-only (no passkey) cannot sign.

Blockers to run: your Google OAuth test-app credentials in `apps/api/.env`, and the API
running with `SOLANA_NETWORK=devnet`.

## Objective

Prove the full PRD_v5 flow on devnet with a fresh user through the Expo client: Google
login → wallet → first top-up (initializes the Smart Account) → SPL deposit (auto-ATA) →
passkey-authorized withdrawal paying its own fee → confirmation → re-login on a second
device sees the same wallet.

## Why

PRD_v5 §12 (success criteria) and PRD_v4 §30 (Definition of Done) define this exact
scenario; PRD_v4 §27 (E2E Test) requires it with real devnet SOL. This is the V1
integration gate before hardening.

## PRD References

- PRD_v5 §3 (flows), §12 (success criteria); PRD_v4 §13 (transaction flow), §14 (fee
  flow), §27 (Integration + E2E tests), §28 (all categories), §30 (Definition of Done)

## Repository Context

- All upstream pieces: 002 (accounts), 003 (credentials), 004/005 (program on devnet),
  006 (adapter), 007 (intents), 008 (recovery), 009 (SDK), 010 (Expo client).
- E2E harness: existing test setup + a headless browser flow (Playwright or documented
  script); devnet faucet for funding the fee payer (PRD_v5 §7).
- Google OAuth E2E may use a test Google app.

## Scope

- E2E scenario per PRD_v5 §12: login; see Smart Account address pre-activation; fund fee
  payer (faucet); first top-up initializes the account; receive SPL (auto-ATA);
  passkey-authorized withdrawal; user fee payer pays the fee; confirmation visible;
  logout; login again (and on a second device); same account.
- The §30 developer snippet run verbatim against devnet.
- Negative paths: insufficient fee SOL fails honestly; OAuth-alone device cannot sign
  (008's guarantee, verified here end-to-end).
- Test report attached to the task (tx signatures, program id, network).

## Out of Scope

- Load/performance testing and mainnet anything (task 012).

## Dependencies

- 002, 003, 005, 006, 007, 008, 009, 010 (everything upstream).

## Acceptance Criteria

- All PRD_v5 §12 bullets pass on devnet in CI or a documented reproducible script.
- Fee for every test transaction is paid by the user's fee payer, verifiable on-chain.
- No sponsorship, treasury, or paymaster appears anywhere in the flow (§14).
- PRD_v4 §28 Acceptance Criteria checklist is re-run and attached as the V1 scorecard.

## Security Considerations

- E2E doubles as the §23 spot-check: inspect that no response/log/analytics payload contains
  secret material during the whole flow.
