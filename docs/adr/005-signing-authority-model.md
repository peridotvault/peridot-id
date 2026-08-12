# ADR 005 — Signing Authority Model: Ed25519 vs secp256r1/WebAuthn

Status: **proposed — requires stakeholder decision** (blocks tasks 005 and 007; PRD_v4 §29
Phase 0 forbids production smart-account code before this is resolved)

This ADR is the **AUTHORITY_MODEL.md** deliverable of PRD_v4 Phase 0.

## Context

PRD_v4 separates four things that must never collapse into one (§8):

```text
OAuth Identity ≠ Signing Authority ≠ Smart Account ≠ Fee Payer
```

The Smart Account (ADR 004, ADR 007) stores an on-chain **authority** — the cryptographic
public material whose corresponding secret authorizes `execute`. PRD_v4 §12 offers exactly
two candidate models and commands an explicit, documented choice. PRD_v4 §8.2 states the
product preference: *"prefer a browser/device-controlled non-extractable signing mechanism
where practical"* and *"MUST NOT assume that a WebAuthn credential is automatically an
Ed25519 Solana key."*

Constraints from the repository and prior ADRs:

- Client surface is a browser SDK (`packages/sdk-js`); no mobile app exists yet.
- Server is Vercel serverless + Postgres; the server must hold **no** signing capability
  (PRD_v4 §9/§22/§23; ADR 003's "never plaintext keys in Postgres" carried forward).
- The fee payer needs an Ed25519 keypair **regardless of this decision** (ADR 006) — Solana
  fees are Ed25519-signed transactions; a passkey cannot pay fees.
- Solana provides a native secp256r1 signature-verification precompile, so Option B is
  technically implementable on-chain.
- Authority field sizing is model-dependent (PRD_v4 §7.1 note): Ed25519 = 32 bytes;
  secp256r1 = 33-byte compressed / 64-byte uncompressed point. The on-chain state schema
  (ADR 007) and `authorities` table (ADR 004) must match the winner.

## Options

### Option A — Ed25519 device key as authority

```text
Device-generated Ed25519 keypair (client secure storage)
        ↓
Solana Ed25519 signature over the domain-separated action payload
        ↓
Program verifies against smart_account.authority ([u8; 32])
```

- **Pros:** native Solana signature model; simplest program path (ed25519 precompile or
  signer verification); smallest transactions; abundant Anchor reference code; simplest test
  matrix (PRD_v4 §27).
- **Cons:** the key is a file/secret the client must protect and **back up** — multi-device
  and lost-device recovery (PRD_v4 §10) require a key-replication design, and PRD_v4 §9
  forbids silently building a server-side encrypted vault to get it. Without backup, device
  loss with a single credential = lost authority (ADR 006 §5).

### Option B — secp256r1 WebAuthn/passkey authority

```text
Platform passkey (non-extractable, authenticator-held)
        ↓
WebAuthn assertion (secp256r1 signature over authenticatorData ‖ SHA256(clientDataJSON))
        ↓
Program verifies via Solana secp256r1 precompile; challenge binds the Solana payload
        ↓
Smart Account authorization
```

- **Pros:** non-extractable credential in the platform authenticator (PRD_v4 §8.2
  preference); platform passkey sync (iCloud/Google) gives multi-device recovery nearly for
  free (PRD_v4 §10); phishing-resistant origin binding; no key file to exfiltrate.
- **Cons:** substantially more complex on-chain verification — the program must parse
  `authenticatorData`/`clientDataJSON`, enforce the challenge binding to the
  domain-separated Solana payload (PRD_v4 §25), and drive the precompile via instruction
  introspection; larger transactions and compute budget pressure; WebAuthn semantics must
  never be confused with Solana Ed25519 transaction signatures (PRD_v4 §12); the Ed25519
  fee payer still exists alongside (ADR 006), so Option B does **not** eliminate client key
  management — it eliminates it only for the *asset-controlling* authority.

### Rejected without further analysis

- **OAuth-derived or session-derived signing** — violates PRD_v4 §22 Critical: a Google
  login must never manufacture a blockchain signature.
- **Server-held authority key (any encryption-at-rest scheme)** — violates PRD_v4 §9 and the
  §23 answer this ADR set must preserve ("compromised API cannot steal assets").
- **MPC / multi-party signing** — explicit PRD_v4 §1.2 non-goal.

## Recommendation to the stakeholder

**Adopt Option B (secp256r1 passkey) as the V1 authority, with Option A as the documented
fallback trigger.** Rationale:

1. It is the PRD's own stated preference (§8.2) and the only option where the
   *asset-controlling* secret is non-extractable.
2. Multi-device recovery (PRD_v4 §10 acceptance criteria) is a platform feature instead of a
   Peridot-built key-backup system we are forbidden from building silently (§9).
3. The complexity is real but bounded to one verification path in the program; the fallback
   is honest: **if Phase 4 (task 007/008) cannot land precompile verification inside its
   test budget, the stakeholder may flip to Option A by amending this ADR** — the schema
   (ADR 004) and program state (ADR 007) already carry a `type` discriminant and
   model-dependent authority sizing, so the flip is an ADR amendment, not a rewrite.

The question the stakeholder must answer: **is the Phase-4 complexity budget for
WebAuthn-on-chain verification acceptable for V1, or does V1 ship Option A?**

## Consequences (either option)

- `authorities.type` ∈ {`ed25519`, `secp256r1`} (ADR 004); `credential_id` populated for
  passkeys.
- Multiple credentials per account, revocation, rotation (PRD_v4 §10) are model-agnostic and
  proceed regardless.
- On-chain `update_authority` (rotation) requires authorization by a current valid authority.
- The fee payer (ADR 006) is unaffected: Ed25519, device-held, either way.
- Program `execute` verification path (ADR 007) is implemented per the winning option only;
  the losing option's code path is not built (YAGNI).

## Security considerations

- **Option A threat shape:** key extraction via XSS/malicious extension/compromised device
  (PRD_v4 §23.4–§23.6) is the dominant risk; mitigations are storage hygiene and rotation.
- **Option B threat shape:** WebAuthn challenge-substitution and origin/RP-ID confusion
  (§23.10, §23.15); mitigations are strict challenge binding to the Solana payload and
  server-side origin validation (PRD_v4 §22).
- **Both:** replay protection via on-chain nonce + domain separation (PRD_v4 §24/§25);
  a compromised Peridot API cannot sign in either model (§23).
- **Both:** the signed payload is domain-separated (`PERIDOT/SOLANA/SMART_ACCOUNT/v1`,
  PRD_v4 §25) so a signature cannot be replayed across contexts.

## Migration considerations

None — no authority data exists in V3. The `authorities` table is created empty by task 003;
this decision only gates what task 005 registers into it.

## References

- PRD_v4 §8, §9, §10, §12, §22, §23, §24, §25, §27, §28 (Authorization), §29 Phase 0/3.
- ADR 003 (custody escalation), ADR 004 (account model, authorities table), ADR 006 (fee
  payer & recovery), ADR 007 (program verification path).
- Solana secp256r1 precompile (`Secp256r1SigVerify1111111111111111111111111`).

Blocks: tasks 005 (credential lifecycle), 007 (program verification path).
