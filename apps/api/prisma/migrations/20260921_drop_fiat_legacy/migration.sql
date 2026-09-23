-- Drop the pre-production Checkout/Kirim local ledger. DOKU Embedded Wallet
-- (WaaS) is the authoritative ledger; mapping lives in fiat_provider_*.
-- No production data ever existed in these tables (dev-only rows).

DROP TABLE IF EXISTS "fiat_topups";
DROP TABLE IF EXISTS "fiat_withdraws";
DROP TYPE IF EXISTS "FiatTopupStatus";
DROP TYPE IF EXISTS "FiatWithdrawStatus";
