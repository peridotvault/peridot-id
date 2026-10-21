-- PKCE S256 for public SSO clients (ANT-284). Nullable additive columns:
-- existing codes read as NULL (no PKCE binding) so this applies cleanly to
-- any existing database with zero data loss. New public-client codes store
-- the S256 challenge; exchange must present the matching verifier.
-- Down (manual): ALTER TABLE "sso_codes" DROP COLUMN "codeChallenge",
--   DROP COLUMN "codeChallengeMethod";

ALTER TABLE "sso_codes" ADD COLUMN IF NOT EXISTS "codeChallenge" TEXT;
ALTER TABLE "sso_codes" ADD COLUMN IF NOT EXISTS "codeChallengeMethod" TEXT;
