-- XP & Leveling Core (ANT-89 M1, plan rev 4 R1/R2/R4). Additive-only:
-- new tables + two additive columns on pid_apps. No existing table is
-- altered beyond the additive columns; no data rewritten.
--
-- Down (manual — Prisma has no down-migration runner; additive rollback is
-- code-level: redeploy the previous API build and the tables sit unused.
-- To fully revert on a scratch copy:
--   DROP TABLE "xp_task_completions", "xp_ledger_entries", "xp_tasks",
--     "user_xp_states", "xp_level_thresholds", "xp_org_quotas", "xp_quotas",
--     "xp_suspicious_activities", "xp_policy_versions";
--   ALTER TABLE "pid_apps" DROP COLUMN "xpEnabled", DROP COLUMN "approvedEventTypes";

-- 1. Additive per-app XP permission columns (default: no XP permission).
ALTER TABLE "pid_apps" ADD COLUMN "xpEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pid_apps" ADD COLUMN "approvedEventTypes" TEXT[] NOT NULL DEFAULT '{}';

-- 2. Policy versions + materialized thresholds.
CREATE TABLE "xp_policy_versions" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "formula" JSONB NOT NULL,
    "maxLevel" INTEGER DEFAULT 100,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(3),
    "supersededAt" TIMESTAMPTZ(3),

    CONSTRAINT "xp_policy_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "xp_policy_versions_version_key" ON "xp_policy_versions"("version");
-- Exactly one active policy: activated AND not superseded (R4 activation flip).
CREATE UNIQUE INDEX "xp_policy_versions_single_active" ON "xp_policy_versions"(("activatedAt" IS NOT NULL AND "supersededAt" IS NULL)) WHERE "activatedAt" IS NOT NULL AND "supersededAt" IS NULL;

CREATE TABLE "xp_level_thresholds" (
    "policyVersionId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "cumulativeXp" BIGINT NOT NULL,

    CONSTRAINT "xp_level_thresholds_pkey" PRIMARY KEY ("policyVersionId", "level"),
    CONSTRAINT "xp_level_thresholds_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "xp_policy_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 3. Per-user derived state (lazy genesis L1/0 XP on first read).
CREATE TABLE "user_xp_states" (
    "pid" TEXT NOT NULL,
    "totalXp" BIGINT NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "policyVersionId" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_xp_states_pkey" PRIMARY KEY ("pid"),
    CONSTRAINT "user_xp_states_pid_fkey" FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_xp_states_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "xp_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 4. Tasks (admin CRUD ships M2; verification checker column required R3).
CREATE TABLE "xp_tasks" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "xpReward" INTEGER NOT NULL,
    "recurring" TEXT NOT NULL DEFAULT 'once',
    "lifetimeLimit" INTEGER,
    "dailyLimit" INTEGER,
    "weeklyLimit" INTEGER,
    "monthlyLimit" INTEGER,
    "cooldownSecs" INTEGER,
    "availableFrom" TIMESTAMPTZ(3),
    "availableUntil" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "verificationType" TEXT NOT NULL DEFAULT 'internal_state',
    "verificationChecker" TEXT,
    "scopeAppId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "xp_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "xp_tasks_scopeAppId_fkey" FOREIGN KEY ("scopeAppId") REFERENCES "pid_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "xp_tasks_key_key" ON "xp_tasks"("key");
CREATE INDEX "xp_tasks_status_idx" ON "xp_tasks"("status");
CREATE INDEX "xp_tasks_scopeAppId_idx" ON "xp_tasks"("scopeAppId");

-- 5. Append-only XP journal (independent of the financial ledger).
CREATE TABLE "xp_ledger_entries" (
    "id" TEXT NOT NULL,
    "pid" TEXT NOT NULL,
    "deltaXp" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "levelAfter" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "taskId" TEXT,
    "eventId" TEXT,
    "appId" TEXT,
    "reason" TEXT,
    "actorAdminId" TEXT,
    "policyVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xp_ledger_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "xp_ledger_entries_pid_fkey" FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "xp_ledger_entries_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "xp_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "xp_ledger_entries_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "xp_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "xp_ledger_entries_pid_createdAt_idx" ON "xp_ledger_entries"("pid", "createdAt");
CREATE INDEX "xp_ledger_entries_eventId_idx" ON "xp_ledger_entries"("eventId");

-- 6. Completions: uniqueness is eventId ONLY (R1). One-time tasks use the
-- two partial unique indexes below (Prisma cannot express partials).
CREATE TABLE "xp_task_completions" (
    "id" TEXT NOT NULL,
    "pid" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "isOnce" BOOLEAN NOT NULL DEFAULT false,
    "resourceId" TEXT,
    "awardedEntryId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xp_task_completions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "xp_task_completions_pid_fkey" FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "xp_task_completions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "xp_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "xp_task_completions_awardedEntryId_fkey" FOREIGN KEY ("awardedEntryId") REFERENCES "xp_ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "xp_task_completions_eventId_key" ON "xp_task_completions"("eventId");
CREATE UNIQUE INDEX "xp_task_completions_awardedEntryId_key" ON "xp_task_completions"("awardedEntryId");
CREATE INDEX "xp_task_completions_pid_idx" ON "xp_task_completions"("pid");
CREATE INDEX "xp_task_completions_taskId_pid_idx" ON "xp_task_completions"("taskId", "pid");
-- R1: one-time tasks — at most one completion per (task, pid).
CREATE UNIQUE INDEX "xp_task_completions_once_pid" ON "xp_task_completions"("taskId", "pid") WHERE "isOnce" AND "resourceId" IS NULL;
-- R1: once-per-achievement variant — one completion per (task, pid, resource).
CREATE UNIQUE INDEX "xp_task_completions_once_resource" ON "xp_task_completions"("taskId", "pid", "resourceId") WHERE "isOnce" AND "resourceId" IS NOT NULL;

-- 7. Quotas (M3 enforcement; admin-configured, never hardcoded).
CREATE TABLE "xp_quotas" (
    "appId" TEXT NOT NULL,
    "dailyCap" INTEGER,
    "weeklyCap" INTEGER,
    "monthlyCap" INTEGER,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendReason" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "xp_quotas_pkey" PRIMARY KEY ("appId"),
    CONSTRAINT "xp_quotas_appId_fkey" FOREIGN KEY ("appId") REFERENCES "pid_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "xp_org_quotas" (
    "ownerPid" TEXT NOT NULL,
    "dailyCap" INTEGER,
    "weeklyCap" INTEGER,
    "monthlyCap" INTEGER,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "xp_org_quotas_pkey" PRIMARY KEY ("ownerPid"),
    CONSTRAINT "xp_org_quotas_ownerPid_fkey" FOREIGN KEY ("ownerPid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "xp_suspicious_activities" (
    "id" TEXT NOT NULL,
    "pid" TEXT,
    "appId" TEXT,
    "signal" TEXT NOT NULL,
    "detail" JSONB,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xp_suspicious_activities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "xp_suspicious_activities_pid_fkey" FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "xp_suspicious_activities_reviewed_createdAt_idx" ON "xp_suspicious_activities"("reviewed", "createdAt");

-- 8. Seed: default policy v1 (R5-locked formula) + materialized L1-100 curve.
-- Threshold for level L = cumulative XP to REACH L (L1 = 0).
INSERT INTO "xp_policy_versions" ("id", "version", "formula", "maxLevel", "createdBy", "activatedAt") VALUES ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 1, '{"base": 100, "exponent": 1.5, "rounding": "floor"}', 100, 'system', CURRENT_TIMESTAMP);
INSERT INTO "xp_level_thresholds" ("policyVersionId", "level", "cumulativeXp") VALUES ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 1, 0), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 2, 100), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 3, 382), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 4, 901), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 5, 1701), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 6, 2819), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 7, 4288), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 8, 6140), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 9, 8402), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 10, 11102), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 11, 14264), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 12, 17912), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 13, 22068), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 14, 26755), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 15, 31993), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 16, 37802), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 17, 44202), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 18, 51211), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 19, 58847), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 20, 67128), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 21, 76072), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 22, 85695), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 23, 96013), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 24, 107043), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 25, 118800), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 26, 131300), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 27, 144557), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 28, 158586), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 29, 173402), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 30, 189018), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 31, 205449), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 32, 222709), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 33, 240810), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 34, 259767), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 35, 279592), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 36, 300298), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 37, 321898), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 38, 344404), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 39, 367828), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 40, 392183), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 41, 417481), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 42, 443733), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 43, 470952), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 44, 499148), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 45, 528334), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 46, 558520), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 47, 589718), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 48, 621939), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 49, 655194), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 50, 689494), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 51, 724849), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 52, 761270), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 53, 798767), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 54, 837351), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 55, 877032), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 56, 917821), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 57, 959727), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 58, 1002761), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 59, 1046932), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 60, 1092250), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 61, 1138725), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 62, 1186367), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 63, 1235185), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 64, 1285189), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 65, 1336389), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 66, 1388793), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 67, 1442411), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 68, 1497252), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 69, 1553326), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 70, 1610641), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 71, 1669207), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 72, 1729032), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 73, 1790126), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 74, 1852497), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 75, 1916154), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 76, 1981105), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 77, 2047360), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 78, 2114927), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 79, 2183814), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 80, 2254030), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 81, 2325584), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 82, 2398484), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 83, 2472738), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 84, 2548354), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 85, 2625341), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 86, 2703707), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 87, 2783460), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 88, 2864608), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 89, 2947159), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 90, 3031121), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 91, 3116502), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 92, 3203310), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 93, 3291553), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 94, 3381238), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 95, 3472374), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 96, 3564968), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 97, 3659028), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 98, 3754561), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 99, 3851576), ('8d678f03-4bba-4b33-86ba-3fbe92dc60ba', 100, 3950079);
