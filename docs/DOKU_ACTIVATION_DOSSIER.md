# DOKU Activation & Support Dossier — Unified Ledger funding (PTS issuance)

Status: **NOT SENT — forward as-is to DOKU account manager + support.**
Nothing in the application may proceed past corroborated-read behavior until
every item below is answered AND verified live (see
`SANDBOX_VERIFICATION_MATRIX.md`). No code changes are gated on this dossier
being merely sent; they are gated on the capability being **activated and
verified**.

## 0. Context (what we run)

- Product: PeridotID — gaming identity wallet. First-party mobile wallet +
  backend API orchestrating DOKU Sub-Account V2 as the authoritative
  financial ledger (fiat) and intending to use the Unified Ledger (POINT)
  as the spendable-balance ledger, 1:1 IDR peg.
- Environment under test: **sandbox** (`api-sandbox.doku.com`), merchant
  credentials already working (B2B auth OK, register OK, balance OK —
  verified live, Sep 2026; see `FIAT_SUBACCOUNT.md` § verification report).
- Observed blocker: `POST /sub-account/v2.0/transfer-inquiry` with
  `type: DOKU_NON_FIAT`, `currency: POINT` returns
  **`4004203 Source account not configured for TOPUP`**.
- Our integration posture: DOKU is the ledger of record. We never simulate
  balances application-side; unavailable funding must surface as a
  retryable/deferred operation, never as issued value.

## 1. Request 1 — Activate Unified Ledger (sandbox merchant first)

Please activate the **Unified Ledger** service on our sandbox merchant
account (Dashboard → Settings → Service → + Add Service → Wallet as a
Service → Unified Ledger), or confirm the correct provisioning path if it
is not self-service. Confirm in writing once active, then repeat for the
production merchant only after sandbox verification passes.

## 2. Request 2 — Confirm / provision `DOKU_SYSTEM_POINT_ACCOUNT_NO`

Our backend requires the merchant (Level-1) `DOKU_SYSTEM_POINT` funding
account number for `DOKU_NON_FIAT` top-ups. Please confirm the exact
account number for both sandbox and (later) production, **and** answer:

1. Is `DOKU_SYSTEM_POINT` created automatically on Unified Ledger
   activation, or is a separate provisioning request required?
2. **Funding semantics — do not leave this to inference:**
   a. May `DOKU_SYSTEM_POINT` carry a **negative** balance equal to points
      outstanding? Is an unbounded negative balance permitted, or is there
      a floor/limit?
   b. Is any **collateral or pre-funding** required before the first
      top-up? If yes, what instrument, what minimum, and how is it topped
      up operationally?
   c. Are there per-transaction / daily **limits** on top-up issuance?
   d. How exactly is TOPUP funding accounted for on your side (negative
      ledger entry only, or is there a settlement/clearing step against
      our fiat balance)? Is there any fee charged on issuance itself?
3. What is the expected behavior (exact response code/message) when
   issuance is attempted **before** the funding source is ready, so we can
   distinguish "not yet provisioned" from other failures?

## 3. Request 3 — BANK_ACCOUNT payout requirements (redemption path)

Our model pays end users from platform pool liquidity via documented
`transfer-payment` `type: BANK_ACCOUNT`. Please provide, in writing:

1. The exact **beneficiary/bank-code list** (valid `beneficiaryBankCode`
   values) and where it is published/maintained.
2. Per-transfer and daily **minimum/maximum amounts**, per-channel
   (`BI_FAST` vs `ONLINE`) cutoff times, and fee schedule (who bears the
   fee, when it is deducted).
3. **Settlement timing**: when debited from the source sub-account vs when
   credited to the beneficiary; exact `latestTransactionStatus` lifecycle
   (`03` → `00`?) and webhook payload/sequence for payout.
4. **Idempotency**: confirm duplicate `partnerReferenceNo` returns 409
   without double payout, and that `transactions-status` is authoritative
   for recovery.
5. **Sandbox test-beneficiary procedure**: how do we obtain or provision a
   test bank beneficiary in sandbox? If DOKU cannot provide one, say so
   explicitly — obtaining/provisioning one becomes our prerequisite and we
   will not invent test credentials.

## 4. Request 4 — IDR consolidation confirmation

To fund payouts we intend ordinary `DOKU_SUB_ACCOUNT` IDR transfers from
backing-rich user sub-accounts into a designated Treasury/operating IDR
account (all journaled/reconciled as real DOKU movements). Please confirm
this pattern is supported and whether any restriction applies (velocity
limits, approval, same-hierarchy requirement). If a dedicated
Treasury/operating pool account type exists instead, specify how to
provision it.

## 5. Request 5 — Adjustment schedules for reconciliation

To reconcile aggregate backing we need, in writing: per-channel PG-fee
schedule (deducted pre-settlement), settlement-fee behavior, refund/
chargeback notification shapes and timelines, and any other routine
adjustments (reserves, holds). Our invariant treats **every** nonzero
backing difference as guilty-until-explained, so an authoritative list is
required — a percentage tolerance will not be used.

## 6. What we will send back after activation

For each capability above: dated request/response captures, reference
numbers, status transitions, webhook payloads, and a reconciliation
report with zero unexplained discrepancies — or a stop-at-boundary report
quoting actual provider behavior. Test entities will be sandbox-only,
clearly marked, and never mixed with real users.

---
Prepared: 2026-09-23. Owner: platform team. Forward to: DOKU account
manager (activation + commercial) and DOKU support (technical answers).
