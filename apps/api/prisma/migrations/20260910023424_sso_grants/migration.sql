-- CreateTable
CREATE TABLE "sso_grants" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "clientId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sso_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sso_grants_identityId_idx" ON "sso_grants"("identityId");

-- CreateIndex
CREATE UNIQUE INDEX "sso_grants_identityId_origin_key" ON "sso_grants"("identityId", "origin");
