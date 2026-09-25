# `@peridotvault/pid-sdk-js`

The PeridotID browser SDK. A thin, dependency-light `fetch` client that wraps the
PeridotID API: **auth** (Google + passkey), **identity**, **profile**, the
**passkey wallet** (non-custodial Solana smart account), and **fiat**
(DOKU-backed IDR sub-accounts: top-up, transfer, balance).

Layering: primitives (hashes, WebAuthn ceremonies, key custody) live in
`@peridotvault/pid-core`, the chain adapter in `@peridotvault/pid-solana` — this
package only calls the API directly (no hosts, no prod defaults; `baseUrl` is
caller-supplied). Third-party apps delegate trust-critical actions to the
hosted popup on the PeridotID origin (see "Popup flow" below).

## Install

```sh
npm install @peridotvault/pid-sdk-js
```

## Quick start

```ts
import { Peridot } from '@peridotvault/pid-sdk-js';

const peridot = Peridot({
  baseUrl: 'https://api.pid.peridotvault.com',
  solanaRpcUrl: 'https://api.devnet.solana.com', // for smart-account txs
  popupBaseUrl: 'https://app.pid.peridotvault.com', // trust-critical actions open here
  onUnauthorized: async () => {
    const ok = await peridot.auth.refresh();
    if (!ok) {
      const url = await peridot.auth.login();
      if (url) window.location.assign(url);
    }
  },
});

const loginUrl = await peridot.auth.login(); // Google OAuth URL — navigate to it
if (loginUrl) window.location.assign(loginUrl); // (new users land on the PID picker)
const me = await peridot.identity.me();        // Identity { pid, ... }
await peridot.profile.update({ displayName: 'PeridotPlayer' });
const available = await peridot.auth.pidAvailable('ifal'); // { available, pid }
```

## Domains

| Domain | Class / namespace | Methods |
|---|---|---|
| Auth | `peridot.auth` | `login()`, `loginWithPasskey()`, `exchange(code)`, `logout()`, `refresh()` |
| Identity | `peridot.identity` | `me()`, `credentials()`, `unlinkCredential(id)` |
| Profile | `peridot.profile` | `me()`, `update(input)` |
| Passkey credentials | `peridot.passkey` | `list()`, `register()`, `revoke(id)` |
| Wallet | `peridot.wallet` | smart-account balance, history, deposit, withdraw (see `PeridotWallet`) |
| Fiat | `peridot.fiat` | balance, statement (`ledger`), send/receive, DOKU Checkout top-up (writes approve via popup, see below) |

EVM permissions (WHITEPAPER.md §10) are not SDK-wrapped yet: use `@peridotvault/pid-evm`
(payload + calldata builders) with the `v1/permissions` API directly
(`POST grants/validate`, `GET denied-selectors`).

## Auth

### Google (default)

```ts
const url = await peridot.auth.login(); // Google OAuth URL — navigate to it
if (url) window.location.assign(url); // returns to CLIENT_SUCCESS_URL
```

### Passkey

```ts
const res = await peridot.auth.loginWithPasskey(); // { ok, pidCode? }
if (!res.ok) return; // user cancelled the WebAuthn prompt
// logged in — the session cookie is set
```

### Cross-origin SSO (for relying parties on a different domain, e.g. Live2Dev)

A relying party that needs to create/link its own user from a PeridotID login can use
`returnTo` + a one-time exchange code — no cross-site cookie sharing required.

```ts
// Start login and request to be returned to your own origin with a pid_code.
const url = await peridot.auth.login({ returnTo: 'https://live2dev.com/auth/callback' });
if (url) window.location.assign(url);
// (or) await peridot.auth.loginWithPasskey({ returnTo: 'https://live2dev.com/auth/callback' });
```

The browser lands on `https://live2dev.com/auth/callback?pid_code=...`. Your page
(server-side) exchanges the code for the identity:

```ts
const identity = await peridot.auth.exchange(code);
// identity = { pid, identityId (deprecated shim), profile: { displayName, avatarUrl }, credentials: [{ provider, email }] }
```

`returnTo` must be an origin in your app's `allowedOrigins` (registered via
`POST /v1/apps`), otherwise the login request is rejected. (Legacy global
`CLIENT_REDIRECT_ALLOWLIST` still covers pre-`client_id` integrations.)

### Third-party apps ("Sign in with PeridotID")

Register your app once (`POST /v1/apps`, authenticated) to get a public `client_id`,
then pass it on every login — the issued code is bound to your app and only exchanges
with the same `clientId`:

```ts
const url = await peridot.auth.login({ clientId: 'pidapp_...', returnTo: 'https://mygame.dev/callback' });
if (url) window.location.assign(url);
const res = await peridot.auth.loginWithPasskey({ clientId: 'pidapp_...', returnTo: 'https://mygame.dev/callback' });
const identity = await peridot.auth.exchange(code, 'pidapp_...');
```

For React apps, wrap the flow in your own button + hook: `openLoginTab()` opens
the auth page in a **new tab** (Google + the PID picker if the visitor has no
PeridotID yet) and resolves with the pid_code; `peridot.auth.exchange(code)` gets
the identity (see "Sign in with PeridotID" in the docs).

## Popup flow (third-party origins)

**Auth** opens a new tab (`openLoginTab`, alias `openLoginPopup`) — it is a full
page flow (Google + PID creation) that must not be a cramped popup.
**Confirmations** — `withdraw`, `execute`, `activate`, `rotate`, `topup`, fiat
top-up and P2P transfer — never run in the developer's DOM. With `popupBaseUrl`
set (and no inline `passkeySigner`), they open a small popup on the PeridotID
origin, where the user approves with the address bar visible:

```ts
const peridot = Peridot({
  baseUrl: 'https://api.pid.peridotvault.com',
  solanaRpcUrl: 'https://api.devnet.solana.com',
  popupBaseUrl: 'https://app.pid.peridotvault.com',
});

await peridot.wallet.withdraw({ amount: '5000000', asset: 'SOL', to: '...' });
// ^ opens the popup; resolves with { signature, … } after user approval.

// Fiat (internal ledger): the popup shows server-quoted amounts + origin.
// Top-up navigates the popup itself to the DOKU payment page on Approve.
const deposit = await peridot.fiat.checkoutDeposit('100000'); // { paymentUrl, grossIdr, feeIdr, netIdr, … }
const bal = await peridot.fiat.balance();                     // { balanceIdr, source: 'fiat-ledger' }
const sent = await peridot.fiat.transferViaPopup({ amountIdr: '100000', beneficiaryPid: 'live2dev@pid' });
// Pass the initiating app's clientId to stack that app's fee (credits the app):
const sent2 = await peridot.fiat.transferViaPopup({ amountIdr: '100000', beneficiaryPid: 'live2dev@pid', clientId: 'pidapp_...' });
```

Split inquiry/confirm (`transferInquiry`/`transferConfirm`) are first-party
inline only — in popup mode they throw and direct you to `transferViaPopup()`,
the single approved ceremony (inquiry runs server-side on the host, so the
summary can never show a forged recipient or amount). Any identity can send to
any identity; fees are global 0.1% (min Rp100, no cap) plus any per-app fee.

Apps, fees, and machine auth have no dedicated wrapper — use the raw client
(`peridot.get/post/patch/put/delete`):

```ts
await peridot.put(`/v1/apps/${id}/fees/topup`, { percentBps: 200, minIdr: '0', maxIdr: '10000', enabled: true });
// Server-side backend token for the app's escrow (no browser session):
//   POST /v1/auth/token { clientId, clientSecret } → { accessToken, expiresIn }
```

Read-only calls (`getBalance()`, `tokens()`, `history()`, `activity()`, `me()`,
`activation()`, fiat `balance()`/`ledger()`/`feePolicy()`) always run inline —
there is nothing to exploit there. `openPeridotPopup` / `openLoginPopup` are
exported for custom flows.

A minimal third-party sample lives at `apps/web/app/workspace/demo`
(behaves like an external dapp: popup only, no session).

## Error contract

- Fiat methods **throw** `Error` (message = server message or fallback).
- Auth/wallet reads return `T | ApiError` unions — check with `"statusCode" in res`
  (legacy-stable; unification is roadmap, not 1.0 scope).
- Popup writes throw (`PopupBlockedError`, `PopupClosedError`, access-denied
  as plain `Error`). A closed or timed-out popup never resolves — treat it
  as rejected and let the user retry.

## Low-level / server-side helpers

- `registerPasskey(...)` — drive a WebAuthn registration ceremony manually
- `authenticatePasskey(...)` — drive a WebAuthn authentication ceremony manually
- `BrowserPasskeySigner` — a `PasskeySigner` backed by `navigator.credentials`
- `FeePayerManager` / `SecretStore` — fee-payer secure storage (defaults to in-memory)

`PeridotClient` is exported for advanced use; the `Peridot()` factory is the recommended
entry point.

## Options

| Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | PeridotID API base URL |
| `solanaRpcUrl` | `string \| string[]` | Solana RPC for smart-account txs |
| `passkeySigner` | `PasskeySigner` | optional; inline signer — first-party PeridotID origin only. Omit on third-party origins (with `popupBaseUrl`): `withdraw`/`execute`/`activate`/`rotate`/`topup` then delegate to the popup |
| `popupBaseUrl` | `string` | optional; popup host for delegated ceremonies, e.g. `https://app.pid.peridotvault.com` (no prod default) |
| `feePayerStore` | `SecretStore` | optional; defaults to in-memory |
| `historyStore` | `HistoryStore` | optional; defaults to localStorage-backed |
| `onUnauthorized` | `() => void` | called on `401` (except `/v1/auth/*`) |

## Publish

```sh
pnpm --filter @peridotvault/pid-sdk-js publish --access public --no-git-checks
```

Publish **last** — depends on `pid-types`, `pid-solana` and `pid-payments`.
See CHANGELOG.md for release notes (1.0.0 is the first public major).
