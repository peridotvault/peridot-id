-- Token registry globalization: one Token row (symbol/name/logo) + one
-- TokenDeployment row per chain (chainId FK -> chains.id, mint, decimals).
-- Data migrates from registry_tokens (matched to chains by namespace+reference;
-- orphans are dropped), logos collapse to public/tokens/<SYMBOL>.png.
-- The new symbol keys are uploaded separately (Wasabi); rows only point at keys.

-- CreateTable
CREATE TABLE "tokens" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_deployments" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "token_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tokens_symbol_key" ON "tokens"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "token_deployments_tokenId_chainId_key" ON "token_deployments"("tokenId", "chainId");

-- CreateIndex
CREATE UNIQUE INDEX "token_deployments_chainId_mint_key" ON "token_deployments"("chainId", "mint");

-- AddForeignKey
ALTER TABLE "token_deployments" ADD CONSTRAINT "token_deployments_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_deployments" ADD CONSTRAINT "token_deployments_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate data: one token per symbol (name from the first row, logo by symbol).
INSERT INTO "tokens" ("id", "symbol", "name", "logoKey", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "symbol", MIN("name"), 'public/tokens/' || UPPER("symbol") || '.png', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "registry_tokens"
GROUP BY "symbol";

-- Migrate data: deployments joined to chains (orphans dropped).
INSERT INTO "token_deployments" ("id", "tokenId", "chainId", "mint", "decimals", "isVisible", "isPinned", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid(), t."id", c."id", r."mint", r."decimals", r."isVisible", r."isPinned", r."sortOrder", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "registry_tokens" r
JOIN "tokens" t ON t."symbol" = r."symbol"
JOIN "chains" c ON c."namespace" = r."chainNamespace" AND c."reference" = r."chainReference";

-- DropTable
DROP TABLE "registry_tokens";
