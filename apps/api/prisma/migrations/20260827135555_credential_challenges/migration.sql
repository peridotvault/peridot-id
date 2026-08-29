-- CreateTable
CREATE TABLE "credential_challenges" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "approvalChallenge" TEXT,
    "isAdditional" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credential_challenges_accountId_idx" ON "credential_challenges"("accountId");

-- AddForeignKey
ALTER TABLE "credential_challenges" ADD CONSTRAINT "credential_challenges_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "peridot_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
