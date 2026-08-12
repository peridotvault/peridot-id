# 009 — Intent & Policy Services

## Status

planned

## Objective

Implement the Intent Service (PRD_v4 §5.4) and Policy Service (§5.5): applications express
`TRANSFER_SOL`-style intents; the system validates, resolves, policy-checks, builds the
domain-separated signing payload, and tracks intent lifecycle.

## Why

PRD_v4 §5.4: applications express desired actions instead of raw chain transactions. §25:
every sign request binds user/account/chain/network/action/destination/amount/nonce/
expiration with domain separation. This is the off-chain half of transaction authorization.

## PRD References

- §5.4 (Intent Service), §5.5 (Policy Service), §13 (transaction flow), §25 (intent
  security), §16 (Wallet API), §29 Phase 5 (partial)

## Repository Context

- `intents` + `transactions` tables from 003; account resolution from 004; on-chain nonce is
  read via the adapter (010) — this task consumes, not implements, the adapter interface.
- NestJS module conventions; OpenAPI-first; Indonesian error messages.
- Policy scope for V1 is exactly the §5.5 list — no session keys (§5.5 explicit).

## Scope

- `intent` module: `POST /v1/wallet/intents` — validate shape, resolve account + chain
  account, apply policy, persist intent with `expires_at`, return the domain-separated
  payload to sign + the prepared unsigned transaction context.
- Policy checks (§5.5): account active; authority registered; chain allowed (solana devnet/
  mainnet per env); ownership; destination/amount validation; replay protection (intent
  single-use + expiry; on-chain nonce enforced by program).
- `POST /v1/wallet/transactions/prepare` and `/submit` + `GET /v1/wallet/transactions/:id`
  wiring the intent → signed-transaction → submission → status pipeline (submission itself
  via 010's adapter).
- Intent expiration sweep: expired intents marked, never executed.

## Out of Scope

- The Solana build/sign/submit mechanics (task 010).
- Policy types beyond §5.5 (no spend limits/session keys — future).
- SDK surface (task 011).

## Dependencies

- 003 (tables), 004 (accounts), 010 (adapter interface).

## Acceptance Criteria

- `TRANSFER_SOL` intent end-to-end against a mocked adapter in integration tests: create →
  policy-pass → payload contains every §25 binding field → expiry enforced.
- Policy rejections return precise Indonesian errors and emit `security_events`.
- Replay: re-submitting a consumed/expired intent fails.
- §27 unit tests: intent hashing, nonce handling.

## Security Considerations

- The payload the user signs must be byte-for-byte what the program verifies (with 007/010 —
  cross-tested in 012).
- Transaction substitution (§23.10): the signed payload binds destination/amount/nonce, so a
  swapped transaction fails on-chain verification.
