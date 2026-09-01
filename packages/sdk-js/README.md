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
  baseUrl: 'https://api.peridot-id.peridotvault.com',
  solanaRpcUrl: 'https://api.mainnet-beta.solana.com', // for smart-account txs
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
| Auth | `peridot.auth` | `login()`, `logout()`, `refresh()` |
| Identity | `peridot.identity` | `me()`, `credentials()`, `unlinkCredential(id)` |
| Profile | `peridot.profile` | `me()`, `update(input)` |
| Passkey credentials | `peridot.passkey` | `list()`, `register()`, `revoke(id)` |
| Wallet | `peridot.wallet` | smart-account balance, deposit, withdraw (see `PeridotWallet`) |

## Low-level / server-side helpers

- `registerPasskey(...)` — drive a WebAuthn registration ceremony manually
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
| `onUnauthorized` | `() => void` | called on `401` (except `/v1/auth/*`) |

## Publish

```sh
pnpm --filter @peridotvault/pid-sdk-js publish --access public --no-git-checks
```

Publish **last** — depends on `pid-types` and `pid-solana`.