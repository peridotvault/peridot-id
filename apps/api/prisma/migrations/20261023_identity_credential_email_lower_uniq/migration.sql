-- Case-insensitive email uniqueness (ANT-233 F3). One email = one PID globally:
-- the claim flow checks `email mode: insensitive` before minting, but two
-- concurrent case-variant claims (Mail@x vs mail@x) could both pass the check
-- and double-mint. This functional unique index makes the loser's INSERT fail
-- atomically; claim.service maps the P2002 violation to a 409 Conflict.
-- NULL emails (passkey-only credentials) are excluded and unaffected.
-- Managed as raw SQL: Prisma cannot express functional indexes in schema.prisma
-- (see the documented stub on IdentityCredential.email). Safe on populated
-- tables: only fails if case-variant duplicates already exist — dedup those
-- manually (keep the oldest row's email, NULL the rest) before deploying.
-- Down (manual): DROP INDEX IF EXISTS "identity_credentials_email_lower_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "identity_credentials_email_lower_uniq"
  ON "identity_credentials" (lower("email"))
  WHERE "email" IS NOT NULL;
