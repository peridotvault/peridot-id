/*
  ADR 003 — wallets: one wallet per PID (`identityId` unique), chain + user-supplied address,
  no key material and no provider (Google) fields (PRD §5, §11). `onDelete: Cascade` is
  defensive, matching the identity -> credential/device convention; PID deletion is soft
  (status/deletedAt), so the hard cascade is never reached in practice.
*/
-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" "IdentityStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_identityId_key" ON "wallets"("identityId");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
