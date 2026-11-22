-- Self-serve app XP tasks: an app-scoped task's `key` is its own event type,
-- so uniqueness moves from global (`key`) to per-scope (`key`, scopeAppId).
-- Postgres treats NULLs as distinct, so the ecosystem-wide namespace needs an
-- explicit partial unique index to stay single-valued.
DROP INDEX "xp_tasks_key_key";

CREATE UNIQUE INDEX "xp_tasks_key_scopeAppId_key" ON "xp_tasks"("key", "scopeAppId");

CREATE UNIQUE INDEX "xp_tasks_key_ecosystem_key" ON "xp_tasks"("key") WHERE "scopeAppId" IS NULL;
