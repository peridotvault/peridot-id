-- PID becomes the permanent user-created `<handle>@pid` identity.
-- Fresh-DB refactor (no backfill): drop the mutable username columns.
-- Identity.id keeps its PK (implicit uniqueness + immutability); rows store
-- the lowercased form so uniqueness is case-insensitive by construction.
DROP INDEX IF EXISTS "profiles_username_key";
ALTER TABLE "profiles" DROP COLUMN IF EXISTS "username";
ALTER TABLE "profiles" DROP COLUMN IF EXISTS "usernameChangedAt";
