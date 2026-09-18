-- Provider-agnostic fiat ledger: gateway id per row, generic response column.
ALTER TABLE "fiat_topups" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'doku';
ALTER TABLE "fiat_topups" RENAME COLUMN "dokuResponse" TO "providerResponse";
