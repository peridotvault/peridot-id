# `@peridotvault/pid-sdk-js`

The PeridotID browser SDK. A thin, dependency-light `fetch` client that wraps the
PeridotID API: **auth** (Google + passkey), **identity**, **profile**, and the
**passkey wallet** (non-custodial Solana smart account).

Layering: primitives (hashes, WebAuthn ceremonies, key custody) live in
`@peridotvault/pid-core`, the chain adapter in `@peridotvault/pid-solana` — this
package only calls the API directly (no hosts, no prod defaults; `baseUrl` is
caller-supplied). The hosted public login UX is `@peridotvault/pid-react`.

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

`returnTo` must be an origin in the API's `CLIENT_REDIRECT_ALLOWLIST` env, otherwise
the login request is rejected.

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

For React apps, use `@peridotvault/pid-react` (`PeridotProvider` + login modal) instead
of wiring this manually.

## Popup flow (third-party origins)

Trust-critical actions — connect, passkey sign-in/registration, `withdraw`,
`execute`, `activate`, `rotate`, `topup` — never run in the developer's DOM.
With `popupBaseUrl` set (and no inline `passkeySigner`), they open a popup on
the PeridotID origin, where the user approves with the address bar visible:

```ts
const peridot = Peridot({
  baseUrl: 'https://api.pid.peridotvault.com',
  solanaRpcUrl: 'https://api.devnet.solana.com',
  popupBaseUrl: 'https://app.pid.peridotvault.com',
});

await peridot.wallet.withdraw({ amount: '5000000', asset: 'SOL', to: '...' });
// ^ opens the popup; resolves with { signature, … } after user approval.
```

Read-only calls (`getBalance()`, `tokens()`, `history()`, `activity()`, `me()`,
`activation()`) always run inline — there is nothing to exploit there.
`openPeridotPopup` / `openLoginPopup` are exported for custom flows.

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

Publish **last** — depends on `pid-types` and `pid-solana`.
