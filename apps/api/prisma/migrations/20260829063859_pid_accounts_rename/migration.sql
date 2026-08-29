-- Rename peridot_accounts → pid_accounts (data-preserving; Postgres updates FK references).
ALTER TABLE "peridot_accounts" RENAME TO "pid_accounts";

-- Rename the table's own constraints to match the new name (FK names elsewhere are unchanged).
ALTER TABLE "pid_accounts" RENAME CONSTRAINT "peridot_accounts_pkey" TO "pid_accounts_pkey";
ALTER TABLE "pid_accounts" RENAME CONSTRAINT "peridot_accounts_identityId_fkey" TO "pid_accounts_identityId_fkey";