-- Wallet challenge carries its SSO target (stage 4 of docs/plan/04): a
-- third-party app completes wallet login from its own embedded modal and
-- receives a one-time pid_code, with no PeridotID-hosted window.
ALTER TABLE "wallet_auth_challenges" ADD COLUMN "redirectTo" TEXT;
ALTER TABLE "wallet_auth_challenges" ADD COLUMN "clientId" TEXT;
ALTER TABLE "wallet_auth_challenges" ADD COLUMN "codeChallenge" TEXT;
