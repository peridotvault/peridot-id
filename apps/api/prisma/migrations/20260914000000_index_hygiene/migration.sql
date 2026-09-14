-- Index hygiene (dedup audit): drop the one truly redundant index and add the
-- missing FK indexes. Non-destructive.
-- sso_grants(pid) lookups are served by the (pid, origin) unique's leftmost
-- prefix, so sso_grants_pid_idx was pure duplicate.
DROP INDEX "sso_grants_pid_idx";
CREATE INDEX "identity_credentials_pid_idx" ON "identity_credentials"("pid");
CREATE INDEX "devices_pid_idx" ON "devices"("pid");
CREATE INDEX "sessions_deviceId_idx" ON "sessions"("deviceId");
CREATE INDEX "pid_accounts_pid_idx" ON "pid_accounts"("pid");
CREATE INDEX "chain_accounts_chainId_idx" ON "chain_accounts"("chainId");
CREATE INDEX "transactions_intentId_idx" ON "transactions"("intentId");
