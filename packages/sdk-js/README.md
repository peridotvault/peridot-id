# `@peridotvault/pid-sdk-js`

The PeridotID browser SDK. A thin, dependency-light `fetch` client that wraps the
PeridotID API: **auth** (Google + passkey), **identity**, **profile**, and the
**passkey wallet** (non-custodial Solana smart account).

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
  onUnauthorized: async () => {
    const ok = await peridot.auth.refresh();
    if (!ok) await peridot.auth.login();
  },
});

await peridot.auth.login();                    // redirect to Google
const me = await peridot.identity.me();        // Identity
await peridot.profile.update({ displayName: 'PeridotPlayer' });
```

## Domains

| Domain | Class / namespace | Methods |
|---|---|---|
| Auth | `peridot.auth` | `login()`, `loginWithPasskey()`, `exchange(code)`, `logout()`, `refresh()` |
| Identity | `peridot.identity` | `me()`, `credentials()`, `unlinkCredential(id)` |
| Profile | `peridot.profile` | `me()`, `update(input)` |
| Passkey credentials | `peridot.passkey` | `list()`, `register()`, `revoke(id)` |
| Wallet | `peridot.wallet` | smart-account balance, history, deposit, withdraw (see `PeridotWallet`) |

## Auth

### Google (default)

```ts
await peridot.auth.login(); // redirects to Google, returns to CLIENT_SUCCESS_URL
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
await peridot.auth.login({ returnTo: 'https://live2dev.com/auth/callback' });
// (or) await peridot.auth.loginWithPasskey({ returnTo: 'https://live2dev.com/auth/callback' });
```

The browser lands on `https://live2dev.com/auth/callback?pid_code=...`. Your page
(server-side) exchanges the code for the identity:

```ts
const identity = await peridot.auth.exchange(code);
// identity = { identityId, profile: { displayName, avatarUrl }, credentials: [{ provider, email }] }
```

`returnTo` must be an origin in the API's `CLIENT_REDIRECT_ALLOWLIST` env, otherwise
the login request is rejected.

### Third-party apps ("Sign in with PeridotID")

Register your app once (`POST /v1/apps`, authenticated) to get a public `client_id`,
then pass it on every login — the issued code is bound to your app and only exchanges
with the same `clientId`:

```ts
await peridot.auth.login({ clientId: 'pidapp_...', returnTo: 'https://mygame.dev/callback' });
const res = await peridot.auth.loginWithPasskey({ clientId: 'pidapp_...', returnTo: 'https://mygame.dev/callback' });
const identity = await peridot.auth.exchange(code, 'pidapp_...');
```

For React apps, use `@peridotvault/pid-react` (`PeridotProvider` + login modal) instead
of wiring this manually.

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
| `feePayerStore` | `SecretStore` | optional; defaults to in-memory |
| `historyStore` | `HistoryStore` | optional; defaults to localStorage-backed |
| `onUnauthorized` | `() => void` | called on `401` (except `/v1/auth/*`) |

## Publish

```sh
pnpm --filter @peridotvault/pid-sdk-js publish --access public --no-git-checks
```

Publish **last** — depends on `pid-types` and `pid-solana`.
