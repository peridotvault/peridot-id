-- Owner-set one-liner for the sign-in consent card (dashboard → Branding).
-- Kept short on purpose: the wallet shows at most two lines.
ALTER TABLE "pid_apps" ADD COLUMN "description" TEXT;
