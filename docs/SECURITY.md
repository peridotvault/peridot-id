# Security

## Posture (V3)

- JWT Access Token
- Refresh Token
- Secure Cookies (web)
- Token rotation
- Rate limiting (wallet creation throttled at 10/min)
- Record-only wallet custody: **no key material is stored, generated, or returned** (ADR 003)
- No server-side or client-side signing in V3
- Audit logs (future)

## Wallet — PRD §9 disposition

One line per PRD §9 bullet, as applied to the chosen architecture (record-only custody, no keys,
no signing, `JwtAuthGuard`-gated wallet routes). Verbs: **mitigated-by-X** (a control addresses
it), **accepted-because-Y** (no action for V3 with reason), **open-follow-up** (explicit gap,
owner: stakeholder — never silently dropped). Source: ADR 003, tasks 006/008.

- **Private key handling** — accepted: no private key material exists in V3 (record-only custody);
  any future custody model requires a new ADR + KMS/provider before keys exist.
- **Secrets management** — accepted: V3 adds no secrets beyond the existing env-based JWT
  secrets; the wallet holds only public address data.
- **Server-side signing** — accepted: signing location is **none** in V3; no signing code exists
  to secure.
- **Client-side signing** — accepted: no signing client is introduced; `@peridot/sdk-js` remains
  a thin fetch client.
- **Auth → wallet authorization boundary** — mitigated-by-`JwtAuthGuard` + token-derived
  `identityId` only + explicit Prisma `select` of public fields (task 006); verified by
  route-level abuse tests (task 008).
- **Session security** — accepted: wallet reuses the existing rotating refresh/session mechanism
  unchanged; per-request identity `status === "active"` check (`jwt.strategy.ts`) covers
  suspended/deleted PIDs.
- **Replay protection** — mitigated-by idempotent creation: one wallet per PID
  (`identityId @unique`, P2002 handled → returns existing wallet), so a replayed `POST /v1/wallet`
  cannot mint duplicates; session reuse rejection already exists for auth.
- **Wallet creation authorization** — mitigated-by `JwtAuthGuard` + throttled create route
  (10/min) + one-wallet-per-PID cardinality; verified by abuse tests.
- **Wallet recovery** — **open-follow-up (owner: stakeholder)**: record-only custody means Peridot
  holds nothing to recover; recovery design is required only when a custody/signing model lands.
- **Account takeover scenarios** — accepted for V3: no key material, no signing, no on-chain
  operation, so the wallet adds no new takeover surface; the association alone grants nothing
  on-chain. Revisit when custody lands (**open-follow-up**).
- **OAuth account takeover scenarios** — accepted: unchanged from V2 posture (email-collision
  rejection per ADR 002, session rotation, throttled auth routes); the wallet adds no credential
  path and is not tied to any provider (PRD §5).
- **Unlink/relink attacks** — mitigated-by design: the wallet keys off the PID, never off a
  provider, so unlinking Google cannot detach or recreate it (PRD §3); last-credential unlink
  guard preserved; covered by the unlink-keeps-wallet test.
- **Database compromise implications** — accepted: the DB holds only public association data
  (chain + address) with **no key material**, so a DB compromise exposes no wallet funds or keys;
  note the "address association ≠ on-chain ownership" caveat (ADR 003).
- **Credential compromise implications** — accepted: a compromised credential is bounded by the
  existing auth controls (rotation, status check, last-credential guard); the wallet has no
  independent key material to compromise in V3.
- **Wallet compromise implications** — accepted/N/A: with no key material, no signing, and no
  on-chain control in V3 there is nothing to compromise; becomes the primary risk only once a
  custody model lands (**open-follow-up**, owner: stakeholder).

---

# V4/V5 — Smart-account wallet (PRD_v4 §23 threat model)

Posture: non-custodial smart account (PDA) owned by a secp256r1 passkey (ADR 005 Option B).
The server holds only public material (addresses, compressed passkey pubkeys, credential IDs,
intents, transaction metadata). The passkey signs the domain-separated authorization payload
on-chain; a client-held Ed25519 fee payer pays fees (ADR 006). Security-relevant controls
verified by the program test suite (task 005), adapter/SDK e2e (006/009), and the API tests
(003/007/008).

## Threat model dispositions (PRD_v4 §23)

1. **Database compromise** — mitigated: the DB has no key material (structural, ADR 006); a
   dump exposes public addresses + passkey pubkeys only; on-chain authority is verified by the
   precompile, so the DB alone cannot move funds.
2. **OAuth account takeover** — mitigated: Google grants a session, never signing authority; a
   fresh login alone cannot register a passkey (existing-credential approval) nor sign
   (passkey ceremony required).
3. **Session theft** — mitigated: rotating refresh tokens, HttpOnly secure cookies, per-request
   `status === "active"` check; sessions grant no on-chain authority.
4. **XSS** — mitigated: no plaintext keys in the app; passkey secrets live in the authenticator;
   fee payer in secure storage; low-value in-memory default store is replaced by WebCrypto/
   keystore pre-mainnet (task 012).
5. **Malicious browser extension** — mitigated: passkey (non-extractable) + origin binding;
   fee payer secret is device-secure; a malicious page cannot exfiltrate the passkey secret.
6. **Compromised device** — mitigated: passkey requires user verification; fee payer blast radius
   = fee SOL only (assets live in the smart account).
7. **Lost device** — mitigated: revoke the lost credential (last-credential guard keeps ≥1);
   platform passkey sync covers cross-device; all-credentials-lost is an accepted, surfaced
   dead end (ADR 006 §5).
8. **Credential theft** — mitigated: passkey is non-extractable; on-chain verification requires
   the live authenticator; low-S + challenge binding prevents signature misuse.
9. **Replay attacks** — mitigated: on-chain nonce + intent expiry + short passkey expiry
   (chain-clock); verified by the replay test (task 005).
10. **Transaction substitution** — mitigated: the WebAuthn challenge binds the domain-separated
    payload (nonce ‖ action ‖ expiry); the program recomputes it from its own args; verified by
    the challenge/args-mismatch test (task 005).
11. **Malicious RPC** — accepted-with-mitigation: multi-endpoint failover (task 012); status read
    against cluster commitment; a lying RPC can misreport but cannot forge execution.
12. **Malicious app using the SDK** — mitigated: intents are policy-checked and single-use;
    every withdrawal requires an explicit passkey ceremony; destination/amount are bound.
13. **Smart-contract bugs** — mitigated: adversarial test suite (task 005) + planned external
    audit before mainnet (task 012).
14. **Upgrade-authority compromise** — mitigated: upgrade authority held off developer machines,
    moved to a stakeholder hardware/multisig key before mainnet (task 012).
15. **Phishing** — mitigated: passkey origin binding + WebAuthn user verification; UI surfaces
    the exact transaction being approved.
16. **OAuth provider compromise** — mitigated: provider compromise grants a session only; no
    passkey registration without an existing credential, no on-chain signature without the
    authenticator.
17. **Recovery abuse** — mitigated: no OAuth-only recovery path; every new credential needs
    existing-credential approval; verified by `credential.recovery.spec.ts` (task 008).

## Headline answer

> Can a compromised Peridot API steal user assets? **No, not by database/API compromise.** There
> is no key material to steal, and the program verifies the passkey cryptographically on-chain
> (PRD_v4 §23; ADR 005/006/007). The residual server-side risk is availability/integrity
> (censoring/misreporting), not theft.
