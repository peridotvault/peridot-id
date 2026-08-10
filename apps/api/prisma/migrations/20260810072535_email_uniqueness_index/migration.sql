/*
  ADR 002 (Option A) — one email = one PID.

  Partial unique index on non-null `identity_credentials.email`. Prisma cannot express
  partial indexes in schema.prisma, so this is raw SQL. NULL emails (providers that
  return no address) are unaffected.

  Pre-migration audit (required on any database with existing rows — run before `db:deploy`):
    SELECT lower(email) AS email, count(*), array_agg("identityId")
    FROM identity_credentials
    WHERE email IS NOT NULL
    GROUP BY lower(email)
    HAVING count(*) > 1;

  Remediation is NOT automated merging (rejected by PRD §4 / ADR 002). Collisions are a
  product/operational call resolved per case; apply this migration only once zero duplicate
  non-null emails remain. Execution of the audit and remediation is tracked in
  docs/tasks/004 and 009.
*/
-- CreateIndex
CREATE UNIQUE INDEX "identity_credentials_email_key" ON "identity_credentials"("email") WHERE "email" IS NOT NULL;
