# `@peridotvault/pid-react-embed`

Embed the PeridotID wallet UI in any React app (Vite, Next, …). The wallet
renders in an `<iframe>` on the PeridotID origin; **sign-in and every
trust-critical action — send, top-up, transfer — open a popup on the PeridotID
origin**, so the browser address bar stays visible as the unforgeable trust
signal. Nothing that signs or moves money runs in your DOM.

## Install

```sh
npm install @peridotvault/pid-react-embed
```

## Usage

```tsx
import { PeridotWalletEmbed } from "@peridotvault/pid-react-embed";

export function WalletPage() {
  return (
    <div style={{ width: 420, height: 720 }}>
      <PeridotWalletEmbed
        clientId="pidapp_…" // your registered app id
        onIdentity={(id) => console.log("signed in as", id.pid)}
        onError={(e) => console.error(e)}
      />
    </div>
  );
}
```

The component owns the whole ceremony: the iframe shows a Connect button → the
PeridotID login popup runs (Google or passkey) → the component exchanges the
one-time `pid_code` for a read-only bearer and hands it to the iframe → the
wallet renders, reading identity/profile/balance/activity. Writes open the
PeridotID approval popup.

Register the app with `POST /v1/apps` and add the host page's exact origin to its
allowed origins first — login codes are only issued to registered origins.

## Props

| Prop | Description |
| --- | --- |
| `clientId` | Registered app id (`pidapp_…`); binds the login code to your app. |
| `env` / `baseUrl` / `popupBaseUrl` / `walletUrl` | Mirror the SDK options; omit in production for the env preset. |
| `className` / `style` | Sizing comes from the host. Defaults to `width/height: 100%`. |
| `onReady` | The iframe mounted and is listening. |
| `onIdentity` | Signed in; carries `pid`, `profile`, `credentials` (never the bearer). |
| `onError` | Connect or bridge failure. |

## Deployment

The wallet host must allow the frame via `Content-Security-Policy:
frame-ancestors <your-origin>` (set on `app.pid.peridotvault.com`). See the
PeridotID docs "Embed the wallet".

## Notes

- The delegated bearer is read-only (`scope: "read"`, GET-only) and lasts 30
  days, non-refreshable; re-connect when it expires.
- `env`, `baseUrl`, and `popupBaseUrl` mirror the SDK options; omit them in
  production and the environment preset applies.

## License

MIT © Antigane Inc.
