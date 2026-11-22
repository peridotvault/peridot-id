BEGIN;
-- CreateEnum
CREATE TYPE "ProviderCategory" AS ENUM ('web2', 'web3');

-- CreateEnum
CREATE TYPE "ProviderProtocol" AS ENUM ('oauth', 'email_otp', 'passkey', 'wallet_signature');

-- CreateEnum
CREATE TYPE "ChainSupportMode" AS ENUM ('all', 'selected');

-- AlterTable
ALTER TABLE "wallet_auth_challenges" ADD COLUMN     "providerCode" TEXT;

-- AlterTable
ALTER TABLE "claim_tickets" ADD COLUMN     "loginProviderCode" TEXT;

-- AlterTable
ALTER TABLE "sso_codes" ADD COLUMN     "providerCode" TEXT;

-- AlterTable
-- The legacy array is removed only after its memberships have been copied.

-- CreateTable
CREATE TABLE "providers" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image_url" TEXT,
    "category" "ProviderCategory" NOT NULL,
    "protocol" "ProviderProtocol" NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "chain_families" (
    "code" TEXT NOT NULL,

    CONSTRAINT "chain_families_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "credential_domains" (
    "code" TEXT NOT NULL,
    "providerCode" TEXT,
    "namespace" TEXT,

    CONSTRAINT "credential_domains_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "provider_chain_policies" (
    "id" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "mode" "ChainSupportMode" NOT NULL DEFAULT 'selected',

    CONSTRAINT "provider_chain_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_chain_selections" (
    "policyId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,

    CONSTRAINT "provider_chain_selections_pkey" PRIMARY KEY ("policyId","chainId")
);

-- CreateTable
CREATE TABLE "app_login_providers" (
    "appId" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,

    CONSTRAINT "app_login_providers_pkey" PRIMARY KEY ("appId","providerCode")
);

-- CreateTable
CREATE TABLE "app_oauth_configs" (
    "appId" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "secretUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_oauth_configs_pkey" PRIMARY KEY ("appId","providerCode")
);

-- CreateTable
CREATE TABLE "login_events" (
    "id" TEXT NOT NULL,
    "exchangeId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "pid" TEXT NOT NULL,
    "providerCode" TEXT,
    "providerEvidence" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_chain_policies_providerCode_namespace_key" ON "provider_chain_policies"("providerCode", "namespace");

-- CreateIndex
CREATE INDEX "provider_chain_selections_chainId_idx" ON "provider_chain_selections"("chainId");

-- CreateIndex
CREATE UNIQUE INDEX "login_events_exchangeId_key" ON "login_events"("exchangeId");

-- CreateIndex
CREATE INDEX "login_events_appId_pid_occurredAt_idx" ON "login_events"("appId", "pid", "occurredAt");

-- Canonical metadata. Future providers are discoverable but unavailable until their auth adapter ships.
INSERT INTO providers (code,name,category,protocol,"isAvailable") VALUES
 ('google','Google','web2','oauth',true),('apple','Apple','web2','oauth',false),
 ('discord','Discord','web2','oauth',false),('email','Email','web2','email_otp',true),
 ('passkey','Passkey','web2','passkey',true),('phantom','Phantom','web3','wallet_signature',true),
 ('metamask','MetaMask','web3','wallet_signature',true);
INSERT INTO chain_families(code) SELECT DISTINCT namespace FROM chains;
INSERT INTO chain_families(code) VALUES ('eip155'),('solana') ON CONFLICT DO NOTHING;
INSERT INTO credential_domains(code,"providerCode",namespace) VALUES
 ('google','google',NULL),('email','email',NULL),('evm',NULL,'eip155'),('solana',NULL,'solana');
-- Unknown historic issuer values must be reviewed, not silently reclassified as a known brand.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM identity_credentials c LEFT JOIN credential_domains d ON d.code=c.provider WHERE d.code IS NULL)
 THEN RAISE EXCEPTION 'Unknown credential domain: review before provider migration'; END IF;
END $$;
INSERT INTO app_login_providers("appId","providerCode")
 SELECT DISTINCT a.id,m FROM pid_apps a,unnest(a."loginMethods") m;
ALTER TABLE pid_apps DROP COLUMN "loginMethods";
-- Do not guess actual third-party wallet network support. Empty SELECTED policies
-- are intentionally unconfigured; operators populate verified chain selections.
INSERT INTO provider_chain_policies(id,"providerCode",namespace,mode) VALUES
 ('phantom-solana','phantom','solana','selected'),
 ('phantom-evm','phantom','eip155','selected'),
 ('metamask-evm','metamask','eip155','selected');

-- AddForeignKey
ALTER TABLE "identity_credentials" ADD CONSTRAINT "identity_credentials_provider_fkey" FOREIGN KEY ("provider") REFERENCES "credential_domains"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_auth_challenges" ADD CONSTRAINT "wallet_auth_challenges_providerCode_fkey" FOREIGN KEY ("providerCode") REFERENCES "providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_tickets" ADD CONSTRAINT "claim_tickets_loginProviderCode_fkey" FOREIGN KEY ("loginProviderCode") REFERENCES "providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_codes" ADD CONSTRAINT "sso_codes_providerCode_fkey" FOREIGN KEY ("providerCode") REFERENCES "providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chains" ADD CONSTRAINT "chains_namespace_fkey" FOREIGN KEY ("namespace") REFERENCES "chain_families"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_domains" ADD CONSTRAINT "credential_domains_providerCode_fkey" FOREIGN KEY ("providerCode") REFERENCES "providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_domains" ADD CONSTRAINT "credential_domains_namespace_fkey" FOREIGN KEY ("namespace") REFERENCES "chain_families"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_chain_policies" ADD CONSTRAINT "provider_chain_policies_providerCode_fkey" FOREIGN KEY ("providerCode") REFERENCES "providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_chain_policies" ADD CONSTRAINT "provider_chain_policies_namespace_fkey" FOREIGN KEY ("namespace") REFERENCES "chain_families"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_chain_selections" ADD CONSTRAINT "provider_chain_selections_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "provider_chain_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_chain_selections" ADD CONSTRAINT "provider_chain_selections_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_login_providers" ADD CONSTRAINT "app_login_providers_appId_fkey" FOREIGN KEY ("appId") REFERENCES "pid_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_login_providers" ADD CONSTRAINT "app_login_providers_providerCode_fkey" FOREIGN KEY ("providerCode") REFERENCES "providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_oauth_configs" ADD CONSTRAINT "app_oauth_configs_appId_fkey" FOREIGN KEY ("appId") REFERENCES "pid_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_oauth_configs" ADD CONSTRAINT "app_oauth_configs_providerCode_fkey" FOREIGN KEY ("providerCode") REFERENCES "providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_appId_fkey" FOREIGN KEY ("appId") REFERENCES "pid_apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_pid_fkey" FOREIGN KEY ("pid") REFERENCES "identities"("pid") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_providerCode_fkey" FOREIGN KEY ("providerCode") REFERENCES "providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE providers ADD CONSTRAINT provider_protocol_category CHECK
 ((category='web3' AND protocol='wallet_signature') OR (category='web2' AND protocol<>'wallet_signature'));
ALTER TABLE providers ADD CONSTRAINT provider_image_url CHECK
 (image_url IS NULL OR image_url ~ '^https://' OR (image_url LIKE '/%' AND image_url NOT LIKE '//%'));
ALTER TABLE credential_domains ADD CONSTRAINT credential_domain_source CHECK
 (("providerCode" IS NOT NULL)::integer + (namespace IS NOT NULL)::integer = 1);
ALTER TABLE app_oauth_configs ADD CONSTRAINT oauth_secret_encrypted CHECK
 ("clientSecretEnc" LIKE 'enc:v1:%' AND length("clientId") > 0);
ALTER TABLE login_events ADD CONSTRAINT login_provider_evidence CHECK
 (("providerCode" IS NULL AND "providerEvidence"='unknown') OR
  ("providerCode" IS NOT NULL AND "providerEvidence" IN ('server','client_selected')));
-- Cross-table invariants that cannot be expressed as ordinary foreign keys.
CREATE FUNCTION check_provider_chain_selection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p provider_chain_policies; family text;
BEGIN
 SELECT * INTO p FROM provider_chain_policies WHERE id=NEW."policyId" FOR SHARE;
 SELECT namespace INTO family FROM chains WHERE id=NEW."chainId" FOR SHARE;
 IF p.mode <> 'selected' OR family IS DISTINCT FROM p.namespace THEN
   RAISE EXCEPTION 'Chain selection must match a selected policy namespace';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER provider_chain_selection_valid BEFORE INSERT OR UPDATE ON provider_chain_selections
 FOR EACH ROW EXECUTE FUNCTION check_provider_chain_selection();
CREATE FUNCTION check_provider_chain_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM providers WHERE code=NEW."providerCode" AND category='web3' FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Only wallet providers have chain policies'; END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM provider_chain_selections WHERE "policyId"=OLD.id)
 AND (NEW.mode<>'selected' OR NEW.namespace<>OLD.namespace) THEN
  RAISE EXCEPTION 'Remove selections before changing policy mode or namespace'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER provider_chain_policy_valid BEFORE INSERT OR UPDATE ON provider_chain_policies
 FOR EACH ROW EXECUTE FUNCTION check_provider_chain_policy();
CREATE FUNCTION check_oauth_provider() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM providers WHERE code=NEW."providerCode" AND protocol='oauth' FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'OAuth configuration requires an OAuth provider'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER oauth_provider_valid BEFORE INSERT OR UPDATE ON app_oauth_configs
 FOR EACH ROW EXECUTE FUNCTION check_oauth_provider();
-- Default memberships for every new app; runtime API returns a derived loginMethods array.
CREATE FUNCTION default_app_login_providers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO app_login_providers("appId","providerCode") SELECT NEW.id,code FROM providers WHERE "isAvailable";
 RETURN NEW;
END $$;
CREATE TRIGGER app_default_providers AFTER INSERT ON pid_apps FOR EACH ROW EXECUTE FUNCTION default_app_login_providers();

-- Prevent parent edits from invalidating previously valid child rows.
CREATE FUNCTION protect_provider_classification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.protocol IS DISTINCT FROM OLD.protocol OR NEW.category IS DISTINCT FROM OLD.category THEN
  RAISE EXCEPTION 'Provider protocol/category is immutable; introduce a new provider code'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER provider_classification_immutable BEFORE UPDATE ON providers
 FOR EACH ROW EXECUTE FUNCTION protect_provider_classification();
CREATE FUNCTION protect_chain_namespace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.namespace IS DISTINCT FROM OLD.namespace THEN
  RAISE EXCEPTION 'Chain namespace is immutable; introduce a new chain'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER chain_namespace_immutable BEFORE UPDATE ON chains
 FOR EACH ROW EXECUTE FUNCTION protect_chain_namespace();

COMMIT;
