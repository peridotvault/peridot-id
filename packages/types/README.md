# `@peridotvault/pid-types`

Shared TypeScript types for PeridotID — the canonical contracts shared across the API,
browser SDK, and Solana adapter.

## Install

```sh
npm install @peridotvault/pid-types
```

## Usage

```ts
import type { Identity, Profile, Account, Authority, ApiError } from '@peridotvault/pid-types';

async function getIdentity(): Promise<Identity | ApiError> {
  const res = await fetch('/v1/identity/me');
  return res.json();
}
```

## Contents

| Domain | Types |
|---|---|
| Identity | `Identity`, `IdentityStatus`, `IdentityCredential`, `LoginResponse` |
| Profile | `Profile`, `ProfileUpdate` |
| Wallet / accounts | `Wallet`, `WalletCreate`, `ChainAccount`, `Account`, `WalletTransaction` |
| Authority (passkey) | `Authority` |
| Intents | `Intent`, `IntentType`, `IntentPayload`, `IntentCreate` |
| WebAuthn | `RegisterStart` |
| Errors | `ApiError` |

All types are `interface`/`type` only — this package has **zero runtime code**.

## Publish

```sh
pnpm --filter @peridotvault/pid-types publish --access public --no-git-checks
```

Publish first — `pid-solana` and `pid-sdk-js` depend on it.