-- Wallet switches are per-wallet now (OAuth group: passkey/google/email,
-- Wallets group: phantom/metamask). Apps that had the old generic `wallet`
-- method on get both wallets; apps that had it off stay off.
UPDATE "pid_apps"
SET "loginMethods" = "loginMethods" || ARRAY['phantom','metamask']
WHERE 'wallet' = ANY("loginMethods");
UPDATE "pid_apps"
SET "loginMethods" = array_remove("loginMethods", 'wallet')
WHERE 'wallet' = ANY("loginMethods");
ALTER TABLE "pid_apps" ALTER COLUMN "loginMethods" SET DEFAULT ARRAY['passkey','google','email','phantom','metamask'];
