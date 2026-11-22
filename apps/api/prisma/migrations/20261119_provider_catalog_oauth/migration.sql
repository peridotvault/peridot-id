-- Platform-level OAuth client configuration (admin-managed).
-- Additive: no existing rows are read or rewritten. Per-app OAuth storage in
-- app_oauth_configs stays untouched and is not runtime-wired.
CREATE TABLE "platform_oauth_configs" (
    "providerCode" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "redirectUri" TEXT NOT NULL,
    "secretUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_oauth_configs_pkey" PRIMARY KEY ("providerCode")
);

ALTER TABLE "platform_oauth_configs" ADD CONSTRAINT "platform_oauth_configs_providerCode_fkey"
  FOREIGN KEY ("providerCode") REFERENCES "providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The secret is stored only as an enc:v1 envelope; plaintext is rejected.
ALTER TABLE "platform_oauth_configs" ADD CONSTRAINT platform_oauth_secret_encrypted CHECK
  ("clientSecretEnc" LIKE 'enc:v1:%' AND length("clientId") > 0);
-- Redirect is server-derived from API_URL, never admin input. http is allowed
-- for loopback development; a public non-TLS redirect is not.
ALTER TABLE "platform_oauth_configs" ADD CONSTRAINT platform_oauth_redirect_https CHECK
  ("redirectUri" ~ '^https://' OR "redirectUri" ~ '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/');

CREATE FUNCTION check_platform_oauth_provider() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM providers WHERE code=NEW."providerCode" AND protocol='oauth' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Platform OAuth configuration requires an OAuth provider';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_oauth_provider_valid BEFORE INSERT OR UPDATE ON "platform_oauth_configs"
  FOR EACH ROW EXECUTE FUNCTION check_platform_oauth_provider();
