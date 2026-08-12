# 013 — Production Hardening (Pre-Mainnet)

## Status

planned

## Objective

Execute PRD_v4 §29 Phase 7: the audits, operational controls, and program upgrade custody
required before mainnet — including the §23 threat-model sign-off.

## Why

PRD_v4 §29 Phase 7 is the mainnet gate. Nothing here is optional for mainnet, and none of
it is needed for devnet iteration — so it is deliberately one late task, not scattered work.

## PRD References

- §22 (security requirements), §23 (threat model), §24 (upgrade authority), §26 (events
  indexability), §27 (testing), §29 Phase 7

## Repository Context

- Existing controls: `@nestjs/throttler`, env-based secrets, Vercel + Supabase deploys.
- New attack surface since V3: on-chain program (007/008), adapter/RPC (010), credentials
  (005/006), intents (009), SDK keys (011).
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
  the docs site for the V4 surface.

## Out of Scope

- Post-mainnet features (sponsorship, session keys, guardians, EVM — PRD_v4 §31).
- Bug-bounty program setup (recommend, don't implement).

## Dependencies

- 012 (E2E proven on devnet).

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
  production RPC), OAuth production apps, DB already migrated by 003.
