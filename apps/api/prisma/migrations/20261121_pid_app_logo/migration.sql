-- App logo for the sign-in consent screens (dashboard → app settings).
-- Nullable: existing apps keep the generic tile until an owner sets one.
ALTER TABLE "pid_apps" ADD COLUMN "logoUrl" TEXT;
