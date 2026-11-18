# Stage 4: Embedded modal and SDK

Status: **Not implemented**.
Dependency: Stage 3; see [plan index](README.md).

## Scope and requirements

Provide login options, wallet discovery/selection, signature cancellation/retry,
PID claim/linking feedback, and authenticated completion without opening a separate
PeridotID login window for the external-wallet path. Keep private keys external.
Preserve origin checks, app binding and existing passkey trust boundaries; never
turn the current read-only SSO bearer into an unrestricted write token.
Test new and returning users, unavailable wallets, rejected signatures, wrong
accounts/networks, refresh/logout, and first-party versus third-party sessions.

## Implementation locations
`packages/react-embed`, `packages/sdk-js/src/auth-client.ts`,
`packages/sdk-js/src/embed.ts`, `apps/wallet/src/feat/auth`, and `apps/docs`.

## Work items
- [ ] Define modal API, callbacks and session handoff against the implemented auth endpoints.
- [ ] Add Phantom/Solana and MetaMask/EVM discovery and signature adapters.
- [ ] Implement loading, cancellation, retry, unavailable-wallet and account-switch states.
- [ ] Integrate new-user PID claim and explicit existing-user wallet linking.
- [ ] Preserve the current hosted flow for existing SDK consumers.
- [ ] Add accessible focus handling, keyboard navigation and error announcements.
- [ ] Test cross-origin app binding, session lifecycle and signature cancellation end to end.
- [ ] Publish examples only for implemented behavior; refresh generated documentation.

## Acceptance
A third-party app can complete external-wallet login from the embedded modal
without opening a separate PeridotID login window. Wallet-controlled approval UI
still appears. External keys never enter host-page code. Existing iframe and
passkey integrations continue to respect their original trust boundaries.

## Rollout and rollback
Ship an opt-in API first. Keep the existing popup integration available until
compatibility is verified. Reverting the modal must not strand user identities.
