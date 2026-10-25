-- ANT-456 SystemSetting table + history + backfill runs (plan §3.1, §3.5).
-- Additive-only (expand): three new tables + static seed rows for the fixed
-- §3 key catalog. No existing table is altered; no data rewritten.
--
-- Seeds mirror apps/api/src/settings/defaults.ts (single source of truth
-- for the static defaults; the migration pins them for existing DBs).
-- Fail-closed posture: intake OFF, suspends OFF (deny-by-absence), limits 0
-- (= no awards that window when enforced), no active policy ("").
--
-- Down (manual — Prisma has no down-migration runner; additive rollback is
-- code-level: redeploy the previous API build and the tables sit unused.
-- To fully revert on a scratch copy:
--   DROP TABLE "xp_backfill_runs", "system_setting_history", "system_settings";

CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "valueType" TEXT NOT NULL,
    "description" TEXT,
    "updatedBy" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "system_setting_history" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_setting_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "system_setting_history_key_createdAt_idx" ON "system_setting_history"("key", "createdAt");

CREATE TABLE "xp_backfill_runs" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "cursor" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "actor" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "xp_backfill_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "xp_backfill_runs_startedAt_idx" ON "xp_backfill_runs"("startedAt");

-- Static seeds (fixed §3 catalog; parameterized keys are deny-by-absence
-- and are added by later migrations per the closed-catalog rule).
INSERT INTO "system_settings" ("key", "value", "valueType", "description", "updatedBy", "version") VALUES
    ('xp.intake.enabled', 'false', 'boolean', 'DB successor of PID_XP_INTAKE_ENABLED. Effective intake additionally ANDs the env flag during transition.', 'seed', 1),
    ('xp.limits.daily', '0', 'integer', 'Global per-PID daily award cap (0 = no awards that window). Reserved: pipeline enforcement lands in a follow-up; per-task/per-quota caps apply meanwhile.', 'seed', 1),
    ('xp.limits.weekly', '0', 'integer', 'Global per-PID weekly award cap (0 = no awards that window). Reserved: see xp.limits.daily.', 'seed', 1),
    ('xp.limits.monthly', '0', 'integer', 'Global per-PID monthly award cap (0 = no awards that window). Reserved: see xp.limits.daily.', 'seed', 1),
    ('xp.policy.active', '""', 'string', 'Active XP policy id. Empty = no policy active = awarding denied when enforced.', 'seed', 1),
    ('xp.policy.thresholds', '{}', 'json', 'Named XP policy thresholds {name: number >= 0}, max 50 entries.', 'seed', 1),
    ('xp.suspend.global', 'false', 'boolean', 'Global XP intake kill-switch (AND NOT with the intake flag).', 'seed', 1);
