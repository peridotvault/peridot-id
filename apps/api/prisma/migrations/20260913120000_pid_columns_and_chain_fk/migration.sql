-- PID column renames + Profile shared-PK + chains compound FK.
-- Hand-written (never auto-generate this one): pure RENAMEs preserve data;
-- `migrate dev` would drop/recreate the PK and lose rows. Postgres carries FK
-- constraints, indexes, and CHECK definitions through RENAME COLUMN
-- automatically; the explicit RENAMEs below only tidy stale object names so
-- future auto-migrations diff cleanly.

-- 1. Identity PK: identities.id -> identities.pid
ALTER TABLE "identities" RENAME COLUMN "id" TO "pid";

-- 2. FK columns -> pid (values already ARE the pid; renames only)
ALTER TABLE "identity_credentials" RENAME COLUMN "identityId" TO "pid";
ALTER TABLE "devices" RENAME COLUMN "identityId" TO "pid";
ALTER TABLE "pid_accounts" RENAME COLUMN "identityId" TO "pid";
ALTER TABLE "security_events" RENAME COLUMN "identityId" TO "pid";
ALTER TABLE "sso_codes" RENAME COLUMN "identityId" TO "pid";
ALTER TABLE "sso_grants" RENAME COLUMN "identityId" TO "pid";
ALTER TABLE "pid_apps" RENAME COLUMN "ownerId" TO "ownerPid";
ALTER TABLE "profiles" RENAME COLUMN "identityId" TO "pid";

-- 3. Profile shared-PK: drop surrogate UUID, pid becomes the PK (strict 1:1).
-- NOTE: Prisma emits @@unique as a UNIQUE *index* (not a constraint) in this
-- project, hence DROP/ALTER INDEX (not CONSTRAINT) for the *_key objects.
DROP INDEX "profiles_identityId_key";
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_pkey";
ALTER TABLE "profiles" DROP COLUMN "id";
ALTER TABLE "profiles" ADD PRIMARY KEY ("pid");

-- 4. Tidy stale constraint/index names (functional no-ops)
ALTER TABLE "profiles" RENAME CONSTRAINT "profiles_identityId_fkey" TO "profiles_pid_fkey";
ALTER TABLE "devices" RENAME CONSTRAINT "devices_identityId_fkey" TO "devices_pid_fkey";
ALTER TABLE "identity_credentials" RENAME CONSTRAINT "identity_credentials_identityId_fkey" TO "identity_credentials_pid_fkey";
ALTER TABLE "pid_accounts" RENAME CONSTRAINT "pid_accounts_identityId_fkey" TO "pid_accounts_pid_fkey";
ALTER TABLE "security_events" RENAME CONSTRAINT "security_events_identityId_fkey" TO "security_events_pid_fkey";
ALTER TABLE "pid_apps" RENAME CONSTRAINT "pid_apps_ownerId_fkey" TO "pid_apps_ownerPid_fkey";
ALTER INDEX "sso_grants_identityId_origin_key" RENAME TO "sso_grants_pid_origin_key";
ALTER INDEX "security_events_identityId_idx" RENAME TO "security_events_pid_idx";
ALTER INDEX "sso_codes_identityId_idx" RENAME TO "sso_codes_pid_idx";
ALTER INDEX "sso_grants_identityId_idx" RENAME TO "sso_grants_pid_idx";
ALTER INDEX "pid_apps_ownerId_idx" RENAME TO "pid_apps_ownerPid_idx";

-- 5. Chains compound FK: backfill registry rows for refs with none (legacy
-- linked_address / counterfactual rows), then constrain. Inactive placeholders
-- so unregistered refs stay queryable but visible as unregistered.
INSERT INTO "chains" ("id", "namespace", "reference", "name", "nativeSymbol", "decimals", "rpcUrls", "isTestnet", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid(), ca."chainNamespace", ca."chainReference", ca."chainReference", 'UNK', 18, '{}', true, false, now(), now()
FROM "chain_accounts" ca
WHERE NOT EXISTS (
  SELECT 1 FROM "chains" c
  WHERE c."namespace" = ca."chainNamespace" AND c."reference" = ca."chainReference"
)
GROUP BY ca."chainNamespace", ca."chainReference";

ALTER TABLE "chain_accounts" ADD CONSTRAINT "chain_accounts_chain_fkey"
  FOREIGN KEY ("chainNamespace", "chainReference") REFERENCES "chains"("namespace", "reference");
