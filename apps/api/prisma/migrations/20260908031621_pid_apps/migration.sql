-- AlterTable
ALTER TABLE "sso_codes" ADD COLUMN     "clientId" TEXT;

-- CreateTable
CREATE TABLE "pid_apps" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "allowedOrigins" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pid_apps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pid_apps_clientId_key" ON "pid_apps"("clientId");

-- CreateIndex
CREATE INDEX "pid_apps_ownerId_idx" ON "pid_apps"("ownerId");

-- AddForeignKey
ALTER TABLE "pid_apps" ADD CONSTRAINT "pid_apps_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
