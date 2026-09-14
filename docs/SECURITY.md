# Security

Posture: non-custodial personal wallet (PDA) owned by a secp256r1 passkey
(ADR 005 Option B). 1 identity = 1 wallet (ADR-008). The server holds only public
material (addresses, compressed passkey pubkeys, credential IDs, intents,
transaction metadata). The passkey signs the domain-separated authorization payload
on-chain; a client-held Ed25519 fee payer pays fees (ADR 006). No key material is
stored, generated, or returned — ever.

Controls: cookie sessions (`pid_access` 15m + rotating `pid_refresh` 30d),
per-request `status === "active"` check (`jwt.strategy.ts`), `JwtAuthGuard` on every
protected route with the owner always from the token (no account ids in URLs, so no
IDOR class), throttled auth/wallet routes, one-wallet-per-PID cardinality, existing-
credential approval for new passkeys, last-credential unlink/revoke guard.

## Threat model dispositions (PRD_v4 §23)

1. **Database compromise** — mitigated: no key material by structure (ADR 006); a dump
   exposes public addresses + passkey pubkeys only; on-chain authority is verified by
   the precompile, so the DB alone cannot move funds.
2. **OAuth account takeover** — mitigated: Google grants a session, never signing
   authority; a fresh login alone cannot register a passkey (existing-credential
   approval) nor sign (passkey ceremony required). Email-collision rejection per ADR 002.
3. **Session theft** — mitigated: rotating refresh tokens, HttpOnly secure cookies,
   per-request `status === "active"` check; sessions grant no on-chain authority.
4. **XSS** — mitigated: no plaintext keys in the app; passkey secrets live in the
   authenticator; fee payer in secure storage.
5. **Malicious browser extension** — mitigated: passkey (non-extractable) + origin
   binding; a malicious page cannot exfiltrate the passkey secret.
6. **Compromised device** — mitigated: passkey requires user verification; fee payer
   blast radius = fee SOL only (assets live in the smart account).
7. **Lost device** — mitigated: revoke the lost credential (last-credential guard keeps
   ≥1); platform passkey sync covers cross-device; all-credentials-lost is an accepted,
   surfaced dead end (ADR 006 §5).
8. **Credential theft** — mitigated: non-extractable passkey; on-chain verification
   requires the live authenticator; low-S + challenge binding prevents signature misuse.
9. **Replay attacks** — mitigated: on-chain nonce + intent expiry + short passkey expiry
   (chain-clock); verified by the replay test.
10. **Transaction substitution** — mitigated: the WebAuthn challenge binds the
    domain-separated payload; the program recomputes it from its own args; verified by
    the challenge/args-mismatch test.
11. **Malicious RPC** — accepted-with-mitigation: multi-endpoint failover; status read
    against cluster commitment; a lying RPC can misreport but cannot forge execution.
12. **Malicious app using the SDK** — mitigated: intents are policy-checked and
    single-use; every withdrawal requires an explicit passkey ceremony;
    destination/amount are bound.
13. **Smart-contract bugs** — mitigated: adversarial program suite + planned external
    audit before mainnet (task 012).
14. **Upgrade-authority compromise** — mitigated: upgrade authority held off developer
    machines, moved to a stakeholder hardware/multisig key before mainnet (task 012).
15. **Phishing** — mitigated: passkey origin binding + WebAuthn user verification; UI
    surfaces the exact transaction being approved.
16. **OAuth provider compromise** — mitigated: provider compromise grants a session
    only; no passkey registration without an existing credential, no on-chain signature
    without the authenticator.
17. **Recovery abuse** — mitigated: no OAuth-only recovery path; every new credential
    needs existing-credential approval; verified by `credential.recovery.spec.ts`.

## Headline answer

> Can a compromised Peridot API steal user assets? **No, not by database/API compromise.**
> There is no key material to steal, and the program verifies the passkey
> cryptographically on-chain (PRD_v4 §23; ADR 005/006/007). The residual server-side
> risk is availability/integrity (censoring/misreporting), not theft.

## Verification

API suite (`credential.*`, `intent.*`, `account.*`, `wallet.*` incl. route authz),
program adversarial suite, adapter/SDK e2e. Run: `pnpm --filter @peridotvault/pid-api
exec jest`. Pre-mainnet: external audit + task 012 hardening.
