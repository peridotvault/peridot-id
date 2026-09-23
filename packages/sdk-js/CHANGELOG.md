# Changelog — @peridotvault/pid-sdk-js

## 1.0.0 — public third-party release (breaking)

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
- Known limitations: `@solana/web3.js` ships in-bundle (pid-core split
  pending — lazy loading alone can't remove it); third-party reads need a
  session (delegated tokens planned); no sandbox env (loopback dev only).
