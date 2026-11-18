-- External-wallet proof-of-ownership challenges (stage 2 of docs/plan/02).
-- Additive only: no existing row or table is touched.
CREATE TABLE "wallet_auth_challenges" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "pid" TEXT,
    "origin" TEXT,
    "message" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_auth_challenges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wallet_auth_challenges_expiresAt_idx" ON "wallet_auth_challenges"("expiresAt");
