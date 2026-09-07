-- CreateTable: one-time SSO exchange codes (cross-domain auth).
CREATE TABLE "sso_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "sessionId" TEXT,
    "redirectTo" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sso_codes_code_key" ON "sso_codes"("code");
CREATE INDEX "sso_codes_identityId_idx" ON "sso_codes"("identityId");
