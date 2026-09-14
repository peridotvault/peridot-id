-- Pending post-auth PID claims (Google-only entry). Single-use tickets with a
-- short TTL; nothing is created until the handle is claimed.
CREATE TABLE "claim_tickets" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "redirectTo" TEXT,
    "clientId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_tickets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "claim_tickets_expiresAt_idx" ON "claim_tickets"("expiresAt");
