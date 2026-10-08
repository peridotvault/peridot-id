-- Email-OTP login challenges (Brevo sender, auth-only). Stores only the
-- SHA-256 hash of the 6-digit code, never the code itself.

CREATE TABLE IF NOT EXISTS "email_otps" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consumedAt" TIMESTAMP(3),
  "requestIp" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_otps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_otps_email_idx" ON "email_otps"("email");
CREATE INDEX IF NOT EXISTS "email_otps_expiresAt_idx" ON "email_otps"("expiresAt");
