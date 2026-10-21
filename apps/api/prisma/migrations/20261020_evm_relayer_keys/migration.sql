-- EVM auto-deploy relayer keys (replaces EVM_RELAYER_SECRET env, ANT-193).
-- One row per EVM chain at most; written via admin-only endpoints, read
-- server-side only. Additive: safe to apply to any existing database.
-- Down (manual): DROP TABLE IF EXISTS "evm_relayer_keys";

CREATE TABLE IF NOT EXISTS "evm_relayer_keys" (
  "id" TEXT NOT NULL,
  "chainId" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evm_relayer_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "evm_relayer_keys_chainId_key" ON "evm_relayer_keys"("chainId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evm_relayer_keys_chainId_fkey') THEN
    ALTER TABLE "evm_relayer_keys" ADD CONSTRAINT "evm_relayer_keys_chainId_fkey"
      FOREIGN KEY ("chainId") REFERENCES "chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
