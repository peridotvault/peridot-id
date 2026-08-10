/*
  Reconcile schema.prisma with the database left by the v2_identity_credentials migration,
  which renamed auth_accounts -> identity_credentials but left a stale `createdAt` column and
  old constraint names behind. The model has no `createdAt`; the column is unused (auto
  DEFAULT CURRENT_TIMESTAMP) so dropping it loses no app data.

  NOTE: the statements are split because PostgreSQL forbids combining `RENAME CONSTRAINT`
  with other subcommands in a single ALTER TABLE.
*/
-- RenamePrimaryKey
ALTER TABLE "identity_credentials" RENAME CONSTRAINT "auth_accounts_pkey" TO "identity_credentials_pkey";

-- DropColumn
ALTER TABLE "identity_credentials" DROP COLUMN "createdAt";

-- RenameForeignKey
ALTER TABLE "identity_credentials" RENAME CONSTRAINT "auth_accounts_identityId_fkey" TO "identity_credentials_identityId_fkey";
