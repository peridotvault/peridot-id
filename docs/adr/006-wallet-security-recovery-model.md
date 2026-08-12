# ADR 006 — Wallet Security & Recovery Model

Status: accepted (with one explicit deferral — encrypted server-side key backup)

This ADR is the **WALLET_SECURITY_MODEL.md** deliverable of PRD_v4 Phase 0 (§29). It answers
the Phase-0 questions: where each secret lives, how the fee payer is managed, how a second
device obtains authorization, and how recovery works.

## Context

PRD_v4's critical security requirement (§0): Peridot must not store a user's plaintext
blockchain private key or seed phrase — **and** because gas sponsorship is out of scope, the
wallet must include a **user-controlled fee-payer signing authority** holding SOL. PRD_v4 §9
forbids silently implementing a server-side encrypted key vault. ADR 003 established the
key-material exposure rule ("nothing sensitive is ever returned") and rejected plaintext keys
in Postgres on a serverless runtime. ADR 005 covers the asset-controlling authority; this ADR
covers everything around it.

Repository constraints: Vercel serverless (no persistent process, no HSM), Postgres-only
datastore, browser SDK client.

## Decision

### 1. Custody model — non-custodial, structurally

Resolves ADR 003's escalation. Custody in V4 is **smart-account custody**: assets live in the
on-chain PDA whose authority is a client-held credential (ADR 005). Peridot's server holds
only public material — addresses, public keys, WebAuthn credential IDs, account IDs,
transaction metadata, policies (PRD_v4 §9 "Allowed"). The server-side forbidden list is
enforced structurally, not by policy: there is no code path, column, or secret manager entry
that can hold a user signing secret.

**Threat-model answer (PRD_v4 §23):** *Can a compromised Peridot API steal user assets?*
**No, not by database/API compromise** — there is no key material to steal, and the program
verifies authority cryptographically on-chain (ADR 007). The residual server-side attack is
availability/integrity (censoring or misreporting), not theft.

### 2. Fee payer — device-generated Ed25519, client-held, per chain account

- At wallet initialization the **client** generates an Ed25519 keypair. The secret is stored
  in platform secure storage (non-extractable WebCrypto where practical; OS keystore when a
  mobile client exists). The server records **only the address** in `wallet_fee_payers`
  (ADR 004).
- The user funds the fee payer with SOL. The fee payer signs the transaction's fee payment;
  the SDK abstracts this from applications (PRD_v4 §8.3).
- **Blast radius of fee-payer compromise is fee SOL only.** Assets sit in the smart account,
  gated by the authority (ADR 005), not by the fee payer. A stolen fee-payer key cannot move
  assets; it can only drain its own fee balance.
- The fee payer is user-controlled by construction: it is **not** a server treasury, not a
  Peridot custodial account, and no sponsorship path exists (PRD_v4 §14).

### 3. No sponsorship — hard rule

Insufficient fee-payer SOL → transaction fails, surfaced honestly to the user (PRD_v4 §14).
No paymaster, no Kora, no treasury top-up, no hidden SOL requirement. The fee-payer balance
and the failure state are SDK/UI-visible (task 011).

### 4. Multi-device — multiple credentials, never key copying

- `authorities` is 1:N per account (ADR 004). A second device gets authorization by
  **registering a new credential**, not by moving a secret.
- Registration of an additional credential requires (a) an authenticated Peridot session **and**
  (b) approval by an existing valid credential — the exact ceremony depends on ADR 005
  (passkey ceremony vs Ed25519 challenge). **OAuth authentication alone must not silently
  grant blockchain signing authority** (PRD_v4 §10): a fresh Google login on a new device is
  necessary but never sufficient to add an authority.
- With Option B (ADR 005), platform passkey sync is the primary multi-device path and needs
  no Peridot machinery at all.

### 5. Recovery — revocation, rotation, explicit flows; honest dead end in V1

- **Revocation:** remove a credential (`DELETE /credentials/:id`, PRD_v4 §16); mirrored
  on-chain via `update_authority` (ADR 007). Guard: the account must keep ≥1 valid authority
  (mirrors the existing last-credential unlink guard,
  `apps/api/src/identity/identity.service.ts`).
- **Rotation:** register new credential → rotate on-chain authority → revoke old. All steps
  emit security events (ADR 004 `security_events`; PRD_v4 §22).
- **Lost device, surviving credential:** authenticate, revoke the lost credential, done.
- **All credentials lost:** **unrecoverable in V1.** OAuth cannot cryptographically recover a
  signing secret (PRD_v4 §10), and no guardian/social recovery exists yet (deferred, §31).
  This is a deliberate, documented product risk: the UX must push second-credential
  registration at wallet creation and surface the consequence plainly. No silent server-side
  escape hatch may be added to soften this (PRD_v4 §9, §32).

### 6. Key-material exposure rule — carried and extended

ADR 003's rule stands and extends per PRD_v4 §22: no plaintext blockchain private keys or
seed phrases in API responses, logs, analytics, error messages, database migrations, source
code, or the database itself; no signing authority material in API logs. CI greps for the
patterns (task 013).

## Rejected alternatives

- **Server-side encrypted vault (keys in Postgres/KMS, unlocked by OAuth session)** —
  rejected per PRD_v4 §9/§32: it reintroduces exactly the server-custody blast radius ADR 003
  rejected, and an OAuth session would become de-facto signing authority. Recorded here as
  the **explicit deferral**: if a future product decision wants seamless cross-device without
  passkeys, it requires a standalone security design and threat model **before** any code.
- **Fee payer derived from the authority credential** — rejected: couples fee compromise to
  asset authority; keeps the §8 four-way separation.
- **Server-generated fee payer with encrypted storage** — rejected: same vault problem,
  smaller stakes; not worth the exception.
- **Silent recovery via email/OAuth reset** — rejected: violates PRD_v4 §10 ("lost-device
  recovery must not allow a compromised OAuth session to steal the wallet").

## Consequences

- Tasks: fee-payer generation/storage lands in the SDK (task 011); credential lifecycle API
  in task 005; recovery flows in task 006; security-event emission across auth/credential/
  wallet paths.
- UX copy requirements (task 006/011): second-credential prompt, fee-SOL insufficiency error,
  all-credentials-lost warning. Error messages follow the Indonesian convention.
- V1 accepts a real availability risk: a user with one unsynced credential who loses the
  device loses the wallet. Recorded, surfaced, and deferred to the guardian phase — not
  engineered around.

## Security considerations

- This ADR *is* the wallet threat model summary; the full 17-item model (PRD_v4 §23) is
  dispositioned in `docs/SECURITY.md` during task 013.
- Dominant residual risks: client-side key/credential theft (XSS, malicious extension,
  compromised device — §23.4–6) and phishing (§23.15). Mitigations: non-extractable
  credentials where the model allows (ADR 005 B), strict origin validation, domain-separated
  payloads, short intent expiry, rate limiting.
- Malicious RPC (§23.11) can lie about confirmations but cannot forge execution; status is
  verified against the cluster, not a single node response (ADR 007 §8, task 013 failover).

## Migration considerations

None — no secret material exists in V3 to migrate. `wallet_fee_payers` is created empty
(task 003). Existing `linked_address` rows (ADR 004) have no keys by definition.

## References

- PRD_v4 §0, §8.3, §9, §10, §14, §22, §23, §25, §28 (Security, Recovery), §29 Phase 0/3, §31, §32.
- ADR 003 (exposure rule, custody escalation), ADR 004 (tables), ADR 005 (authority model),
  ADR 007 (on-chain rotation).
- `apps/api/src/identity/identity.service.ts` (last-credential guard precedent).

Blocks: tasks 005 (credential lifecycle), 006 (recovery flows), 011 (fee payer in SDK).
