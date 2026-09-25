-- Per-app fee schedule (stacks on the global PeridotID fee; credits the app's
-- own account). One row per (app, operation). Additive.

CREATE TABLE IF NOT EXISTS "pid_app_fees" (
  "id" TEXT NOT NULL,
  "appId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "percentBps" INTEGER NOT NULL DEFAULT 0,
  "minIdr" BIGINT NOT NULL DEFAULT 0,
  "maxIdr" BIGINT NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pid_app_fees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pid_app_fees_appId_operation_key"
  ON "pid_app_fees"("appId", "operation");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pid_app_fees_appId_fkey') THEN
    ALTER TABLE "pid_app_fees" ADD CONSTRAINT "pid_app_fees_appId_fkey"
      FOREIGN KEY ("appId") REFERENCES "pid_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
