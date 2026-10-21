-- TZ-skew fix (ANT-317): convert every `timestamp without time zone` business
-- column to TIMESTAMPTZ(3), matching the new `@db.Timestamptz(3)` schema
-- attributes. Root cause: the dispatch due-filter `nextAttemptAt <= now`
-- compared a +07-wall stored value against a UTC-wall driver param, so freshly
-- enqueued `fiat_ledger_events` rows were invisible for ~7h in non-UTC
-- deployments (0 in UTC prod, which is why CI never caught it). Mirror risk:
-- `expiresAt > now` filters stayed true ~7h past expiry.
--
-- Provenance (verified with the repo Prisma client, 2026-10-21): Prisma binds
-- DateTime for naive columns as UTC-wall literals, while DB-side
-- `DEFAULT now()` stores session-TZ walls — the enqueue path omits
-- `nextAttemptAt`, so the DB default wrote +07 walls the Prisma reader never
-- matched. After this migration both writers produce true instants and every
-- comparison is instant-based, so the skew class is gone in any deployment TZ.
--
-- USING ... AT TIME ZONE 'UTC' (deliberate, deterministic in every env):
-- Prisma-bound values (all `expiresAt`, all explicitly-set timestamps) are
-- UTC walls and convert EXACTLY everywhere, including UTC prod. Rows written
-- by DB defaults in non-UTC sessions (Jakarta dev walls) shift up to the UTC
-- offset into the future — bounded, self-healing (pre-existing pending
-- callbacks dispatch up to ~7h late once; new rows are exact), dev-only.
-- The alternative (session-TZ reinterpretation) would instead expire all
-- Prisma-written auth timestamps ~7h early — fail-closed but user-visible —
-- and would do different things per environment. UTC reinterpretation is the
-- safe, uniform contract. No data loss: type widening only, defaults and
-- constraints untouched. Verified on live-shaped data with TimeZone Jakarta
-- (up + down, rolled back) before deploy.
--
-- Down (manual): for each table below run
--   ALTER TABLE "<tbl>" ALTER COLUMN "<col>" TYPE TIMESTAMP(3)
--     USING "<col>" AT TIME ZONE 'UTC';
-- (Only after confirming no timestamptz-dependent reads need the zone.)
ALTER TABLE "authorities" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "authorities" ALTER COLUMN "lastUsedAt" TYPE TIMESTAMPTZ(3) USING "lastUsedAt" AT TIME ZONE 'UTC';
ALTER TABLE "bootstrap_admin_locks" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "chain_accounts" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "chain_accounts" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "chain_contracts" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "chain_contracts" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "chains" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "chains" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "claim_tickets" ALTER COLUMN "consumedAt" TYPE TIMESTAMPTZ(3) USING "consumedAt" AT TIME ZONE 'UTC';
ALTER TABLE "claim_tickets" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "claim_tickets" ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC';
ALTER TABLE "credential_challenges" ALTER COLUMN "consumedAt" TYPE TIMESTAMPTZ(3) USING "consumedAt" AT TIME ZONE 'UTC';
ALTER TABLE "credential_challenges" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "credential_challenges" ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC';
ALTER TABLE "devices" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "devices" ALTER COLUMN "lastSeenAt" TYPE TIMESTAMPTZ(3) USING "lastSeenAt" AT TIME ZONE 'UTC';
ALTER TABLE "email_otps" ALTER COLUMN "consumedAt" TYPE TIMESTAMPTZ(3) USING "consumedAt" AT TIME ZONE 'UTC';
ALTER TABLE "email_otps" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "email_otps" ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC';
ALTER TABLE "evm_relayer_keys" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "evm_relayer_keys" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_fee_policies" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_ledger_entries" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_ledger_events" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_ledger_events" ALTER COLUMN "deliveredAt" TYPE TIMESTAMPTZ(3) USING "deliveredAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_ledger_events" ALTER COLUMN "nextAttemptAt" TYPE TIMESTAMPTZ(3) USING "nextAttemptAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_provider_accounts" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_provider_accounts" ALTER COLUMN "lastBalanceAt" TYPE TIMESTAMPTZ(3) USING "lastBalanceAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_provider_accounts" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_provider_transactions" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_provider_transactions" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_tax_settings" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "fiat_webhook_events" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "identities" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "identities" ALTER COLUMN "deletedAt" TYPE TIMESTAMPTZ(3) USING "deletedAt" AT TIME ZONE 'UTC';
ALTER TABLE "identities" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "identity_credentials" ALTER COLUMN "lastLoginAt" TYPE TIMESTAMPTZ(3) USING "lastLoginAt" AT TIME ZONE 'UTC';
ALTER TABLE "identity_credentials" ALTER COLUMN "linkedAt" TYPE TIMESTAMPTZ(3) USING "linkedAt" AT TIME ZONE 'UTC';
ALTER TABLE "intents" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "intents" ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC';
ALTER TABLE "payment_gateway_fee_rates" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "payment_gateway_fee_rates" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "pid_app_fees" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "pid_app_fees" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "pid_apps" ALTER COLUMN "clientSecretCreatedAt" TYPE TIMESTAMPTZ(3) USING "clientSecretCreatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "pid_apps" ALTER COLUMN "clientSecretExpiresAt" TYPE TIMESTAMPTZ(3) USING "clientSecretExpiresAt" AT TIME ZONE 'UTC';
ALTER TABLE "pid_apps" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "pid_apps" ALTER COLUMN "prevClientSecretExpiresAt" TYPE TIMESTAMPTZ(3) USING "prevClientSecretExpiresAt" AT TIME ZONE 'UTC';
ALTER TABLE "pid_apps" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "profiles" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "profiles" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';
ALTER TABLE "security_events" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "sessions" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "sessions" ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC';
ALTER TABLE "sessions" ALTER COLUMN "revokedAt" TYPE TIMESTAMPTZ(3) USING "revokedAt" AT TIME ZONE 'UTC';
ALTER TABLE "sso_codes" ALTER COLUMN "consumedAt" TYPE TIMESTAMPTZ(3) USING "consumedAt" AT TIME ZONE 'UTC';
ALTER TABLE "sso_codes" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "sso_codes" ALTER COLUMN "expiresAt" TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC';
ALTER TABLE "sso_grants" ALTER COLUMN "firstSeenAt" TYPE TIMESTAMPTZ(3) USING "firstSeenAt" AT TIME ZONE 'UTC';
ALTER TABLE "sso_grants" ALTER COLUMN "lastUsedAt" TYPE TIMESTAMPTZ(3) USING "lastUsedAt" AT TIME ZONE 'UTC';
ALTER TABLE "sso_grants" ALTER COLUMN "revokedAt" TYPE TIMESTAMPTZ(3) USING "revokedAt" AT TIME ZONE 'UTC';
ALTER TABLE "transactions" ALTER COLUMN "confirmedAt" TYPE TIMESTAMPTZ(3) USING "confirmedAt" AT TIME ZONE 'UTC';
ALTER TABLE "transactions" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "wallet_fee_payers" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
