-- CreateEnum
CREATE TYPE "Role" AS ENUM ('user', 'admin');

-- AlterTable
ALTER TABLE "identities" ADD COLUMN     "role" "Role" NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "chains" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nativeSymbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 18,
    "rpcUrls" TEXT[],
    "explorerUrl" TEXT,
    "logoUrl" TEXT,
    "isTestnet" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_contracts" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "versionLabel" TEXT,
    "deployTxHash" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chains_namespace_reference_key" ON "chains"("namespace", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "chain_contracts_chainId_type_key" ON "chain_contracts"("chainId", "type");

-- AddForeignKey
ALTER TABLE "chain_contracts" ADD CONSTRAINT "chain_contracts_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
