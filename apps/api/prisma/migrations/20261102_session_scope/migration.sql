-- App-scoped sessions: label each session with its first-party app namespace
-- (`pid_access_<scope>`), null for the wallet's own session. Settings /
-- Devices uses it to list and revoke a specific app session.
ALTER TABLE "sessions" ADD COLUMN "scope" TEXT;
