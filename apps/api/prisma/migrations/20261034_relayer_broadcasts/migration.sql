-- ANT-581 H2: at-most-once broadcast ledger per (pid, nonce, chain).
-- Expand-only: new table, no data movement, fully backward-compatible.
CREATE TABLE "relayer_broadcasts" (
  "id" TEXT NOT NULL,
  "pid" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "chain" TEXT NOT NULL,
  "entryPoint" TEXT NOT NULL,
  "txBytesHash" TEXT NOT NULL,
  "signature" TEXT,
  "status" TEXT NOT NULL DEFAULT 'claimed',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "relayer_broadcasts_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "relayer_broadcasts" ADD CONSTRAINT "relayer_broadcasts_pid_fkey"
  FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "relayer_broadcasts_pid_nonce_chain_key" ON "relayer_broadcasts"("pid", "nonce", "chain");
CREATE INDEX "relayer_broadcasts_pid_idx" ON "relayer_broadcasts"("pid");
