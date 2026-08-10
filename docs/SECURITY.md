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
