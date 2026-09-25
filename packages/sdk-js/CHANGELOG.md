# Changelog — @peridotvault/pid-sdk-js

## 1.1.0

- Add `openLoginTab()`: auth opens a **new tab** (Google + PID picker for new
  users), not a popup. It resolves with the `pid_code` the tab mints for the
  app's `clientId`. `openLoginPopup` is kept as a deprecated alias (same
  function). Approval ceremonies (transfers, payments) remain small popups.
- `readPopupParams()` now exposes `clientId` (from `?client_id=`), so the hosted
  page can bind the issued code to the app.

## 1.0.0 — public third-party release (breaking)

- **Fiat is now the internal IDR ledger** (DOKU Checkout is money-in only; no
  Sub-Account). `peridot.fiat` covers `balance`, `ledger`, `deposits`,
  `checkoutDeposit`, `syncTransaction`, `transferInquiry`/`transferConfirm`,
  `transferViaPopup`, `cancelTransaction`, `feePolicy`. The former `credit`
  namespace is gone — one `fiat` namespace.
- Fees: global **0.1% (min Rp100, no cap)** plus optional **per-app fees** that
  stack when a movement is initiated with the app's `clientId` (the fee credits
  the app's own account). No withdrawal/cash-out.
- App management, per-app fees, and server-side machine tokens
  (`POST /v1/auth/token`) use the raw client (`get/post/patch/put/delete`).
- Trust-critical actions (wallet writes, fiat top-up/transfer) run in the
  PeridotID popup for third-party origins (`popupBaseUrl`); first-party
  inline use is unchanged. New: `fiat.checkoutDeposit()` and
  `fiat.transferViaPopup()` delegate; split inquiry/confirm/retry are
  first-party inline only. `ApproveScreen` shows server-quoted summaries
  with the requesting origin and navigates itself to the DOKU payment page.
- Removed from the browser client (no in-repo consumers; use raw `fetch`
  server-side): `fiat.debit`, `fiat.debitCancel`, all `fiat.admin*`.
  `PeridotAdmin` stays for the first-party web workspace (role-gated).
- Re-exported input/domain types (`TopupInput`, `WithdrawInput`,
  `ExecuteInput`, `RotateInput`, `Authority`, `Identity`,
  `IdentityCredential`, `Profile`, `ProfileUpdate`, `Session`, `SsoGrant`).
- Error contract (documented, unified in a later major): fiat methods throw
  `Error`; auth/wallet reads return `T | ApiError` unions; popup writes
  throw. See README.
- Server-side app backends authenticate with machine (client-credentials)
  tokens: `POST /v1/auth/token { clientId, clientSecret }` → bearer token bound
  to the app owner's pid (used via the raw client or plain `fetch`).
- Known limitations: `@solana/web3.js` ships in-bundle (pid-core split
  pending — lazy loading alone can't remove it); no sandbox env (loopback dev
  only).
