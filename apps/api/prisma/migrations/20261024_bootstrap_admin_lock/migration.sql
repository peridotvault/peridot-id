-- Serialize the first-admin bootstrap race (ANT-233 F4). The bootstrap grant is
-- one-time (ANT-227 item 2): the first bootstrap-PID claim creates the first
-- admin. Under read-committed, two concurrent bootstrap claims can both observe
-- "no admin exists" and both mint admins. The singleton lock row admits exactly
-- one winner per transaction: the loser gets a PK violation (P2002) and claims
-- as a plain user instead. Equivalent in force to the suggested partial-unique
-- index WHERE role='admin', without forbidding later admins promoted via
-- SQL/admin:promote (which never touch this table).
-- Backward-compatible: empty table on existing databases; the first bootstrap
-- claim after deploy takes the lock. No data migration.
-- Down (manual): DROP TABLE IF EXISTS "bootstrap_admin_locks";

CREATE TABLE IF NOT EXISTS "bootstrap_admin_locks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "pid" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bootstrap_admin_locks_singleton" CHECK ("id" = 'bootstrap-admin')
);
