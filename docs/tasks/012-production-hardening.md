# 012 — Production Hardening (Pre-Mainnet)

## Status

in progress (2026-08-28) — code-side hardening delivered; **stakeholder actions required**
before mainnet are listed below as the runbook.

## Delivered

- **RPC failover** (`packages/solana`): `SolanaRpc` accepts one or more endpoints,
  health-checks the active one, and rotates on failure (verified: dead endpoint → live
  fallback). `solanaRpcUrl` accepts `string | string[]` through the SDK.
- **Threat model** — the 17 PRD_v4 §23 items are dispositioned in `docs/SECURITY.md`
  (mitigated/accepted-with-mitigation), including the headline answer: a compromised API
  cannot steal assets.
- **Rate limiting** — throttles on all sensitive routes (credentials, intents, transactions,
  accounts, wallet) via `@nestjs/throttler`.
- **No-secret checks** — `.gitignore` covers Rust target/test-ledger + keypairs under
  `programs/**/target/deploy`; deployer keypairs are never committed.

## Runbook (stakeholder actions — NOT yet executed)

- [ ] **External program audit** — schedule the Pinocchio program audit (task 005's suite is
  the internal baseline).
- [ ] **Upgrade authority custody** — generate a fresh program keypair, transfer the devnet
  upgrade authority to a **stakeholder-held hardware/multisig key**, and record holder +
  rotation procedure here. Never reuse the devnet program id on mainnet (ADR 007 §9).
- [ ] **Mainnet deploy** — new keypair, `SOLANA_NETWORK=mainnet`, production RPC(s) (2+ for
  failover), production Google OAuth app, Supabase prod DB (already migrated, task 001).
- [ ] **Dependency audits** — run `pnpm audit` + `cargo audit` and fix/accept findings before
  mainnet.
- [ ] **Fee-payer secure storage** — swap the SDK's default in-memory store for WebCrypto
  non-extractable (web) / Expo SecureStore (mobile) via `SecretStore` (task 009).
- [ ] **Observability/alerting** — security-event alerts (revocation spikes, intent-rejection
  spikes), program event indexing.
- [ ] **Backup/restore + incident response** — documented runbooks; CI grep for secret patterns.

## Docs updated

`docs/SECURITY.md` (threat model dispositions), `docs/ARCHITECTURE.md`, `docs/API_SPEC.md`,
`docs/DATABASE.md`, `docs/ROADMAP.md`.

## Objective

Execute PRD_v4 §29 Phase 7: the audits, operational controls, and program upgrade custody
required before mainnet — including the §23 threat-model sign-off.

## Why

PRD_v4 §29 Phase 7 is the mainnet gate. Nothing here is optional for mainnet, and none of
it is needed for devnet iteration — so it is deliberately one late task, not scattered work.

## PRD References

- PRD_v5 §10 (mainnet deployment); PRD_v4 §22 (security requirements), §23 (threat model),
  §24 (upgrade authority), §26 (events indexability), §27 (testing), §29 Phase 7

## Repository Context

- Existing controls: `@nestjs/throttler`, env-based secrets, Vercel + Supabase deploys.
- New attack surface since V3: on-chain program (004/005), adapter/RPC (006), credentials
  (003/008), intents (007), SDK keys (009), Expo client (010).
- `docs/SECURITY.md` holds per-item threat dispositions (V3 pattern; extend it).

## Scope

- **Audits:** external program audit scheduling; internal dependency audit
  (`pnpm audit`, cargo audit); OAuth security review against §22 checklist; key/credential
  review (ADR 005/006 verification).
- **Threat model:** all 17 §23 items dispositioned in `docs/SECURITY.md`; the §23 headline
  answer ("compromised API cannot steal assets") re-verified against the shipped code.
- **Program upgrade controls:** transfer upgrade authority to the stakeholder-held
  hardware/multisig key; document holder + rotation procedure; mainnet deploy with fresh
  program id (ADR 007 §9).
- **RPC failover:** multi-endpoint config + health-checked fallback in `packages/solana`.
- **Rate limiting:** review/extend throttler rules for credential, intent, and transaction
  endpoints.
- **Observability/alerting:** security_events-based alerts (revocation spikes, intent
  rejection spikes, fee-insufficiency anomalies), program event indexing (§26).
- **Backup/restore + incident response:** documented runbooks; CI grep for secret-material
  patterns (ADR 006 §6).
- **Docs:** update ARCHITECTURE.md, DATABASE.md, API_SPEC.md, SECURITY.md, ROADMAP.md, and
  the docs site for the wallet surface.

## Out of Scope

- Post-mainnet features (sponsorship, session keys, guardians, EVM, additional OAuth
  providers, Chrome extension — PRD_v4 §31, PRD_v5 §10).
- Bug-bounty program setup (recommend, don't implement).

## Dependencies

- 011 (E2E proven on devnet).

## Acceptance Criteria

- Every §29 Phase 7 bullet has a linked artifact (audit report, runbook, config, or doc).
- `docs/SECURITY.md` dispositions all 17 threats; no §22 mandatory item is unmet.
- Upgrade authority is off developer machines; mainnet deploy checklist executed and signed
  off by the stakeholder.
- Mainnet Definition of Done (§30) re-run on mainnet with a real (small) transaction.

## Security Considerations

This task *is* the security gate; its output is the evidence that PRD_v4 §22/§23/§24 hold in
production, not just in design.

## Migration Considerations

- Mainnet cutover runbook: new program id, env promotion (`SOLANA_NETWORK=mainnet`,
  production RPC), OAuth production apps, DB already migrated by 001.
