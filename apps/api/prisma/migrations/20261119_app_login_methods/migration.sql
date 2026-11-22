-- Per-app login-method switches (developer dashboard → Integrations).
-- Existing apps keep every method enabled.
ALTER TABLE "pid_apps" ADD COLUMN "loginMethods" TEXT[] NOT NULL DEFAULT ARRAY['passkey','google','email','wallet'];
