# `@peridotvault/pid-react`

React provider + login modal for PeridotID ("Sign in with PeridotID"). Built on
`@peridotvault/pid-sdk-js`. Works against PeridotID production with zero config.

## Install

```sh
npm install @peridotvault/pid-react
```

## Quick start

```tsx
import { PeridotProvider, usePeridot } from '@peridotvault/pid-react';

export default function App() {
  return (
    <PeridotProvider clientId="pidapp_...">
      <YourApp />
    </PeridotProvider>
  );
}

function SignInButton() {
  const { user, openLogin, logout } = usePeridot();
  if (user) {
    return <button onClick={logout}>Sign out ({user.profile.displayName})</button>;
  }
  return <button onClick={openLogin}>Sign in with PeridotID</button>;
}
```

`openLogin()` opens a small modal (Google / passkey chooser) rendered in a portal at
maximum z-index with a blurred backdrop — always in front of your UI. After login,
PeridotID redirects back with a one-time `pid_code`, the provider exchanges it, and
`user` is set.

## Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `clientId` | `string` | — | Your app's id from `POST /v1/apps` (binds codes to your app) |
| `redirectUri` | `string` | current origin | Where PeridotID returns with `?pid_code=` (must be registered) |
| `baseUrl` | `string` | production API | Override for staging/dev |
| `solanaRpcUrl` | `string \| string[]` | devnet | For smart-account txs |
| `methods` | `('google' \| 'passkey')[]` | both | Which buttons the modal shows |
| `onExchange` | `(code) => Promise<void>` | direct exchange | Exchange via your backend instead (mints your own session) |
| `onSuccess` | `(identity \| null) => void` | — | Called after a completed login |
| `onError` | `(err) => void` | — | Called on login/exchange failures |

## Register your app first

`POST /v1/apps` needs your PeridotID session (cookie). From a browser logged into
PeridotID, call it with the SDK:

```ts
import { Peridot } from '@peridotvault/pid-sdk-js';

const peridot = Peridot({ baseUrl: 'https://api.pid.peridotvault.com', solanaRpcUrl: 'https://api.devnet.solana.com' });
const res = await peridot.post('/v1/apps', {
  name: 'My Game',
  redirectUris: ['https://mygame.dev/callback'],
});
// res.data.clientId → "pidapp_..." — put it in <PeridotProvider clientId="...">
```

## How it works

All login ceremonies run on the hosted PeridotID page — Google OAuth needs the
redirect round-trip and WebAuthn legally requires a PeridotID origin, so no ceremony
can run inside your page. The modal is a branded chooser; both buttons navigate to
the hosted page, which returns to `redirectUri?pid_code=...`:

1. User clicks your button → `openLogin()` → modal (Google / Passkey).
2. Either choice navigates to the hosted login (your `clientId` travels along).
3. Provider exchanges the code (directly, or via your `onExchange`) → `user` set.

No API calls happen before login, so there is nothing CORS-related to configure.

## Publish

```sh
pnpm --filter @peridotvault/pid-react publish --access public --no-git-checks
```

Publish **after** `pid-sdk-js`.
