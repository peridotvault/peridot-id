> Follow-up: provider catalogue changes were implemented and migrated locally later
> on 2026-11-19. See [implementation and limitations](../plan/06-provider-catalog-and-login-history.md).
> Findings below are the **pre-change audit snapshot**, not the post-migration schema.

# Database normalization and integrations audit — 2026-11-19

## Scope and limits

Read-only audit of local PostgreSQL `localhost/peridot_id`, current Prisma schema,
SQL migration history, and auth/usage implementation. Database queries ran inside
a REPEATABLE READ, READ ONLY transaction. No application rows, schema, migrations,
secrets, or existing working-tree changes were modified. This document is the only
repository addition from the audit. Production was not inspected.

Inventory: 58 application tables; 81 applied migration records and 82 migration
directories. Local sample: 2 identities, 2 profiles, 2 Google credentials, 1 app,
1 authority, 5 chain accounts, 16 devices, 95 sessions, 53,063 security events.
`app_users`, both usage tables, SSO grants/codes, and fiat payments/ledger are empty.
Consequently zero duplicates in those tables is not evidence of production readiness.

## Aggregate data checks

No duplicate groups found for identity PID (case-folded), credential
(provider, providerUserId), non-null lower(email), app users (app, PID), monthly
usage (app, PID, month), usage events (app, PID, month, reason), grants (PID,
origin), payments (app, externalId), non-null authority credentialId, chain
(chainId, address, accountType), or setting history (key, version).

No missing-app/missing-identity rows found in app users, monthly usage, usage
events or grants; no missing app/beneficiary in payments. No mismatch between
usage events and monthly web3 projection. These latter tables are empty.
No repeated allowed-origin elements or repeated login-method elements found.
One app still has the legacy `wallet` method, incompatible with the current
five-method catalog. Counts only were inspected/exported; no credentials or
personal identifiers are included here.

## Findings, in priority order

### 1. Integration-method migration is not applied locally

`20261119_app_login_methods` is applied; `20261119_app_wallet_login_methods` is
pending. The database contains passkey/google/email/wallet while code expects
passkey/google/email/phantom/metamask. Restarting against the new code without
migration can reject intended wallet logins. Applying migration alone does not
fix findings 2–3. Its array concatenation can also duplicate target elements if
an intermediate row already contains both legacy and new wallet method values;
preflight and deduplicate during any replacement migration.

Evidence: both migration SQL files, `schema.prisma` PidApp, live method aggregate.

### 2. New-wallet PID claim still sends the old method

`auth.controller.ts:58` maps both solana and evm credentials to session method
`wallet`. The claim path reuses that mapping in `ssoService.issue` at line 536.
After migration, app loginMethods no longer includes wallet, so the enforcement
in `sso.service.ts:315` rejects the new-user claim's app code even if the correct
wallet switch is enabled. A returning wallet uses a different mapping in
`wallet-auth.service.ts:221`.

Fix: distinguish session authentication class, cryptographic chain namespace, and
UI connector identity. Use one canonical conversion policy, and test new-user
claim and returning-user login for every enabled/disabled switch combination.

### 3. Existing-session authorize bypasses method enforcement

`auth.controller.ts:319` invokes issue without a method. `sso.service.ts:316`
only checks enabled methods if opts.method is truthy. An existing authenticated
session can therefore authorize an app without its login-method policy being
checked. Method is not persisted in SsoCode, so exchange also cannot re-evaluate
that policy after a switch changes.

Fix: define whether session reuse requires an allowed originating method or a
fresh allowed proof; derive it server-side and enforce consistently. Do not trust
a caller-supplied method flag. This finding is based on code paths, not a live exploit.

### 4. Relations are not enforced for important app-owned records

Live catalog confirms no foreign keys on `app_users`, `usage_events`,
`usage_monthly`, `sso_grants`, `sso_codes`, or `fiat_payments`. Their unique keys
prevent repeated records but do not prevent unknown app/PID references.
`app_users` already has the correct composite primary key; it is not duplicate
identity storage and should remain an app/identity relationship.

Fix: add explicit relations where lifecycle permits. Use soft deletion/RESTRICT
for retained financial and usage history; choose expiry cleanup for temporary
codes. Do not blindly CASCADE-delete audit or money rows. Preflight orphan counts
before adding and validating constraints. For nullable payer/app fields, enforce
references when non-null. Retention exceptions should be explicit and documented.

### 5. Passkey credentialId lacks database uniqueness

`authorities` has only its primary key and pid index. The registration flow
(`credential.service.ts:218`, `:276`) does a findFirst then create. This check is
not a uniqueness guarantee under concurrency. No duplicates exist locally, but
there is only one authority.

Fix: enforce uniqueness for non-null credentialId and map unique conflicts to the
existing registration error. Confirm the intended scope if multiple RP IDs ever
share this database; the current lookup treats IDs as globally unique.

### 6. Login-method arrays lack referential/domain constraints

PidApp.loginMethods is TEXT[] with no live CHECK, foreign-key catalog, or unique
membership constraint. DTO validation and service Set dedupe protect ordinary
API writes but direct SQL, seeds and migrations can introduce unknown/duplicate
values. Allowed origins and approved event types are also arrays; normalized
junction tables become useful when those entities require per-item metadata and
lifecycle. Do not split every small array merely to increase table count.

The method list is repeated in backend DTOs, dashboard metadata and wallet
mapping. This is code/catalog drift, distinct from duplicate user rows.

### 7. MAU and Users have different success boundaries

`SsoService.issue` records total MAU before exchange; wallet verification/claim
records Web3 usage before final app-code exchange. `recordSuccessfulLogin` runs
after exchange. Expired, rejected or abandoned codes can thus appear in MAU while
not appearing in Users. This is a semantic mismatch, not a duplicate-key bug.

Fix: carry verified auth context in the code and record qualifying login/usage
at one successful exchange boundary. Keep idempotency keys, concurrency handling
and a reliable replay/reconciliation strategy. Historical events are currently
one per reason/month, not a complete event-by-event login log. Do not claim full
historical login reconstruction from those rows.

### 8. OAuth app credentials are still only a proposal

There are no googleClientId/googleClientSecretEnc columns or provider-config
table in the inspected live DB/schema. Google strategy still uses platform
startup configuration. Integration switches already live in the app database;
wallet detection is client-side and does not need provider client secrets.

For the requested normalized model, prefer a scoped OAuth configuration table
over three new provider-specific columns per provider in PidApp. Those columns
would not inherently violate 3NF for a single provider, but they couple app
registry schema to each future provider. Configuration and enablement are separate
facts; neither belongs on IdentityCredential or a generic settings JSON blob.
Keep the encryption root key outside the database even when encrypted OAuth
credentials move into it. Never duplicate secrets in app rows, settings and a
provider-config table. Explicit response selects must exclude encrypted secrets.

### 9. Redundant index and schema/documentation drift

`identity_credentials_email_key` (unique exact email, non-null) and
`identity_credentials_email_lower_uniq` (unique lower(email), non-null) both exist.
The latter enforces the stronger uniqueness rule for the intended email semantics.
The exact index is a candidate for removal only after reviewing query plans and
case/collation behavior; uniqueness redundancy is not enough to prove it has no
read-performance benefit.

SQL creates `usage_monthly_appClientId_month_web3_idx`, but Prisma does not declare
that ordinary composite index. Keep schema and migrations aligned so future
diffs do not unexpectedly remove it. Raw partial/expression indexes are different:
Prisma cannot represent all of them, so document and test those intentionally.
Usage schema comments still describe wallet-only events despite app_login support.

## Recommended normalized integration model (proposal, not migrated)

| Entity | Key | Responsibility |
|---|---|---|
| identities | pid | Global person/account identity |
| profiles | pid FK | Current public profile; no app-specific copies |
| identity_credentials | unique(provider, providerUserId), pid FK | Verified login credential ownership |
| authorities | unique non-null credentialId, pid FK | Passkey signing authority; retain separate cryptographic lifecycle |
| pid_apps | id; unique clientId; ownerPid FK | Developer app registry |
| auth_methods | code PK | Canonical method kind and supported connector/protocol metadata |
| app_login_methods | PK(appId, methodCode), both FKs | Enabled/disabled method per app |
| app_oauth_configs | PK(appId, providerCode), FKs | Custom OAuth client ID, encrypted secret, rotation metadata |
| platform_oauth_configs | providerCode PK/FK | Platform default only if moving platform configuration into DB is desired |
| app_users | PK(appClientId, pid), both FKs | One relationship per app/person, first and latest successful login |
| app_origins (when extracted) | PK(appId, origin), app FK | Registered app origins |
| app_grants | PK(appId, pid, origin), relevant FKs | Explicit app-scoped consent/revocation |

For now keep the already-used appClientId reference in app_users/usage if desired:
it is unique and can be a foreign-key target. Replacing every reference with appId
is not required for normalization. Do not persist both IDs in every child row.

App login methods should reference one catalog. OAuth config should reference a
provider-capable catalog entry; passkey and email OTP must not require OAuth client
IDs. UI may group Passkey/Google/Email as requested, but technically only Google
uses OAuth here. Wallet brands are connectors, not cryptographic identity namespaces:
a signature proves control of an address, not which extension created it. The current
solana→Phantom / evm→MetaMask mapping must not be described as a secure brand check.

Existing SsoGrant unique(pid, origin) can have clientId overwritten by another app
using that origin. Decide whether consent is intentionally origin-wide or per-app
before migrating to app_grants. Do not infer historical app association from the
last clientId stored on a shared-origin grant.

Do not create a second global users table, one user per app, one credential per
app, or another fiat balance for each external wallet. Do not delete session,
challenge, ledger, payment snapshot, outbox or setting-history rows just because
PID/amount/value repeats: these represent different facts or immutable evidence.
`usage_monthly` is an intentional projection of usage_events; retain only with a
clear authoritative source and reconciliation contract. No need for another copy.

## Safe execution sequence

1. Reconcile the pending method migration with the chosen catalog/junction design.
   Fix new-claim and existing-session enforcement before declaring switches complete.
2. Add canonical method catalog and app-method rows; backfill with DISTINCT,
   validate enabled-method parity and at least one supported method per active app.
   Ensure the non-empty rule survives concurrent updates (lock/transaction or trigger).
3. Add scoped OAuth configs only for the required custom-client feature; explicit
   platform fallback, encrypted secret lifecycle, shared identity resolution.
4. Add uniqueness and FK constraints after duplicate/orphan checks; preserve history.
5. Align successful login, Users and MAU; reconcile projections and add negative tests.
6. Switch reads/writes to the new canonical tables. Remove the old array only after
   parity checks; avoid permanent dual writes. Roll back code before removing new data.
7. Review index redundancy with query plans, then clean docs and regenerate clients.

Acceptance: no duplicate membership, invalid method or unknown parent can be
inserted; app-owner scoping holds; disabled methods are rejected on all paths;
repeat/parallel login records one app-user and one monthly PID; new and returning
users work identically; billing remains reporting-only; financial history survives.
