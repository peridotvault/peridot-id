# Changelog — @peridotvault/pid-sdk-js

## 1.5.0

- **Multi-account auth.** `auth.accounts()` lists the identities signed into the
  browser; `auth.switchAccount(pid)` makes a linked identity active without
  re-authenticating; `auth.signOutAccount(pid)` forgets one (leaves the rest).
  New `AccountView` type (from `@peridotvault/pid-types` ≥ 0.1.5).
- **Per-app session isolation.** `Peridot({ sessionScope })` adds an
  `x-pid-scope` header so a first-party client app reads its own session cookies
  (`pid_access_<scope>`), separate from the wallet's — signing out of either
  never signs out the other.
- **First-party login without a client_id/secret.** `loginPopup({ firstParty,
  sessionScope })` authenticates via the wallet popup and mints the client app's
  own scoped session (`auth.grantSession(scope)`); no `pid_code`, no consent
  redirect. The popup always asks the user to approve.
- `readPopupParams()` now parses `first_party` and `session_scope`.

## 1.4.1

- **Approval popups survive sign-in.** `readPopupParams()` now persists the
  popup's request params in `sessionStorage`, so an approval popup can route
  through the OAuth sign-in round-trip (whose callback returns to the bare
  wallet origin) and resume the approval. New `clearPopupParams()` drops the
  persisted context once the ceremony resolves (called by `postPopupResult`).

## 1.4.0

- **Login opens a popup, not a tab.** `peridot.auth.loginPopup()` (and
  `openLoginPopup()`) now open a centered popup sized for the full flow — Google,
  the consent card, and the **Create your PID** step for new users. The window
  stays open through all of it and closes only once the user allows (the opener
  receives the `pid_code`) or denies/cancels. Falls back to a new tab when the
  popup is blocked.
- `auth.loginTab()` / `openLoginTab()` retained for apps that prefer a tab.
  `openLoginPopup` is no longer an alias of `openLoginTab` — it is the real popup.

## 1.3.1

- `auth.loginTab({ method })` — pass `method: 'passkey'` to auto-start the
  passkey ceremony in the hosted tab (otherwise the user picks).

## 1.3.0

- **Configure once with `clientId` (+ optional `clientSecret`).** `Peridot({
  clientId, clientSecret?, env? })` — the app id is applied by default to
  `auth.login`, `auth.loginTab`, `auth.authorize`, `auth.exchange`, and every
  `fiat.*` call. No per-call `clientId`, no URLs.
- **`env: 'production' | 'sandbox'`** override added on top of the
  `NODE_ENV`-derived default — a production build can target sandbox (staging)
  with one word.
- `clientSecret` is backend-only (used by `auth.exchange`); never ship it in
  browser code.

## 1.2.0

- **No URLs to configure.** `baseUrl`/`popupBaseUrl` are now optional and the
  environment is auto-detected from `NODE_ENV`: `production` → production,
  anything else (unset, `development`, `staging`, `test`, …) → sandbox. Passing
  `baseUrl` (self-host/localhost) still wins and disables the popup preset.
- **`solanaRpcUrl` removed.** Chains, RPC endpoints, and the program id are read
  from the API chain registry (`GET /v1/chains`) — the wallet resolves its
  Solana adapter lazily from there. No chain/RPC config in SDK options or env.
- New `peridot.auth.loginTab({ clientId })` — opens the PeridotID sign-in tab
  with the configured popup host and resolves the `pid_code` (no host to pass).

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
