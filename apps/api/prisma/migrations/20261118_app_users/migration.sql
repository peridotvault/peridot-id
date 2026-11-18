CREATE TABLE "app_users" (
  "appClientId" TEXT NOT NULL,
  "pid" TEXT NOT NULL,
  "firstLoginAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLoginAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_users_pkey" PRIMARY KEY ("appClientId", "pid")
);
CREATE INDEX "app_users_appClientId_lastLoginAt_idx" ON "app_users"("appClientId", "lastLoginAt");
-- Start fresh: origin-scoped legacy grants can change clientId, so their timestamps
-- cannot safely be attributed to a particular app. Monthly usage is not login history.
