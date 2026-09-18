# Security

Posture: non-custodial personal wallet (smart account) owned by a secp256r1
passkey (secp256r1 owner passkey; ADR-009 for the EVM permission layer). 1 identity =
1 wallet. The server holds only public material (addresses,
compressed passkey pubkeys, credential IDs, intents, transaction metadata). The
owner passkey signs the domain-separated authorization payload on-chain; on EVM
V4 the owner may additionally register scoped P-256 **session keys**
(`sessions[permissionId]`, `contracts/WHITEPAPER.md` §10) that sign executions
inside owner-set scope only. A client-held Ed25519 fee payer pays Solana fees; EVM submission is relayer-sponsored (`networkFee + protocolFee`).
No key material is stored, generated, or returned — ever.

Controls: cookie sessions (`pid_access` 15m + rotating `pid_refresh` 30d),
per-request `status === "active"` check (`jwt.strategy.ts`), `JwtAuthGuard` on every
protected route with the owner always from the token (no account ids in URLs, so no
IDOR class), throttled auth/wallet routes, one-wallet-per-PID cardinality, existing-
credential approval for new passkeys, last-credential unlink/revoke guard.

## Threat model dispositions (PRD_v4 §23)

1. **Database compromise** — mitigated: no key material by structure; a dump
   exposes public addresses + passkey pubkeys only; on-chain authority is verified by
   the precompile, so the DB alone cannot move funds.
2. **OAuth account takeover** — mitigated: Google grants a session, never signing
   authority; a fresh login alone cannot register a passkey (existing-credential
   approval) nor sign (passkey ceremony required). Email-collision rejection per the email-uniqueness rule.
3. **Session theft** — mitigated: rotating refresh tokens, HttpOnly secure cookies,
   per-request `status === "active"` check; cookie sessions grant no on-chain
   authority. (Separate concern: on-chain **session keys** — EVM V4 scoped
   capabilities, threat 18.)
4. **XSS** — mitigated: no plaintext keys in the app; passkey secrets live in the
   authenticator; fee payer in secure storage.
5. **Malicious browser extension** — mitigated: passkey (non-extractable) + origin
   binding; a malicious page cannot exfiltrate the passkey secret.
6. **Compromised device** — mitigated: passkey requires user verification; fee payer
   blast radius = fee SOL only (assets live in the smart account).
7. **Lost device** — mitigated: revoke the lost credential (last-credential guard keeps
   ≥1); platform passkey sync covers cross-device; all-credentials-lost is an accepted,
   surfaced dead end (last-credential guard). On EVM V4, permissions outlive any single device
   only inside their owner-set `validUntil` (≤ 30d) and die immediately on
   owner-signed `revokePermission`.
8. **Credential theft** — mitigated: non-extractable passkey; on-chain verification
   requires the live authenticator; low-S + challenge binding prevents signature misuse.
9. **Replay attacks** — mitigated: on-chain owner nonce (V3 ops; EVM V4 grants,
   revokes, module installs) + per-permission `seq` (strict, then incremented) +
   `chainid` + account bound into every payload + short execution TTL (chain-clock,
   ≤600s) + permission `validAfter/validUntil` (≤30d); verified by the replay tests.
10. **Transaction substitution** — mitigated: the WebAuthn challenge binds the
    domain-separated payload; the program recomputes it from its own args; verified by
    the challenge/args-mismatch test.
11. **Malicious RPC** — accepted-with-mitigation: multi-endpoint failover; status read
    against cluster commitment; a lying RPC can misreport but cannot forge execution.
12. **Malicious app using the SDK** — mitigated: intents are policy-checked and
    single-use; every owner withdrawal requires an explicit passkey ceremony;
    destination/amount are bound. EVM V4 session executions are multi-use *inside*
    the grant (per-tx + lifetime caps, expiry, owner revocation) and need no
    per-transaction ceremony by design — the ceremony happened at grant time;
    scope, replay, and revocation are enforced on-chain (threat 18).
13. **Smart-contract bugs** — mitigated: adversarial EVM suite (65 forge tests incl.
    33 permission/adversarial + anvil V4 loop) and SVM adversarial suite + planned
    external audit before mainnet (WHITEPAPER.md §12). V4 is pre-audit engineering: no
    mainnet deploy or immutability action on this basis alone (WHITEPAPER.md §12).
14. **Upgrade-authority compromise** — mitigated: upgrade authority held off developer
    machines, moved to a stakeholder hardware/multisig key before mainnet (WHITEPAPER.md §12).
15. **Phishing** — mitigated: passkey origin binding + WebAuthn user verification; UI
    surfaces the exact transaction being approved.
16. **OAuth provider compromise** — mitigated: provider compromise grants a session
    only; no passkey registration without an existing credential, no on-chain signature
    without the authenticator.
17. **Recovery abuse** — mitigated: no OAuth-only recovery path; every new credential
    needs existing-credential approval; verified by `credential.recovery.spec.ts`.
18. **Session-key / permission abuse (EVM V4)** — mitigated by construction, proven
    by the adversarial suite (`contracts/WHITEPAPER.md` §10): a stolen session
    key spends only inside its grant (exact target+selector or canonical
    transfer-shape, per-tx + lifetime caps, expiry) and cannot create approvals,
    call the account itself, reenter privileged paths, use `delegatecall` (banned
    in bytecode + CI), or produce a usable ERC-1271 signature (owner-only with
    account+chain rehash). The owner revokes unilaterally (`revokePermission`,
    immediate, no session cooperation). Installing a malicious module needs an
    owner signature; `executeFromExecutor` accepts only installed executors and
    re-checks the full permission inside the account. Residual risk: session-key
    theft spends up to the grant's remaining caps until expiry/revocation — keep
    grants narrow and short-lived.
19. **Session-key / gameplay abuse (SVM sessions, ADR-010)** — mitigated by
    construction, proven by the validator suite (`contracts/WHITEPAPER.md` §11
    §5): the vault PDA never enters game CPIs, so a stolen session key or a
    malicious game (even forwarding the lent signer onward) cannot move vault
    SOL, SPL/Token-2022 tokens, or NFTs — the honest forwarding residual is
    session-owned tokens only, containable per session via protected listing.
    Session SOL is structurally immobile (system program debits only data-less
    accounts). Delegate/close_authority edits are caught even with unchanged
    balances; expired/inactive/revoked/replayed sessions are rejected;
    `remaining_accounts` are rejected outright. Residual risks: theft spends
    session-owned value until expiry/revocation (keep sessions short and
    protected-listed); upgraded allowlisted games keep session scope visibly
    (record-and-log, no enforcement — owner-accepted, monitor `last_seen_*`).

## Headline answer

> Can a compromised Peridot API steal user assets? **No, not by database/API compromise.**
> There is no key material to steal, and the program/contract verifies the passkey
> cryptographically on-chain (PRD_v4 §23; WHITEPAPER.md). The residual server-side
> risk is availability/integrity (censoring/misreporting), not theft. On EVM V4 the
> same holds for permissions: grants are owner-signed, and the backend never holds
> session keys — theft of a session key is a client-side event bounded by threat 18.
> On SVM the same holds for sessions: registration is owner-signed, gameplay needs
> the session key the backend never holds — bounded by threat 19.

## Verification

API suite (`credential.*`, `intent.*`, `account.*`, `wallet.*`, `permissions.*`,
`session-keys.*` incl. route authz), EVM adversarial suite (65 forge tests),
SVM adversarial suites (37 integration + 24 session cases), adapter/SDK e2e
(V3 + V4 anvil loops). Run: `pnpm --filter @peridotvault/pid-api
exec jest` (259 tests) and `forge test --root contracts/evm` (65 tests).
Pre-mainnet: external audit + pre-mainnet hardening (WHITEPAPER.md §12).
