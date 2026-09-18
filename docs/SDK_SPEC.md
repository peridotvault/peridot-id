# SDK

Browser SDK (`@peridotvault/pid-sdk-js`). Full usage guide: see the public docs at `apps/web`
(`content/docs/(general)/sdk.mdx`).

```ts
const peridot = Peridot({
  baseUrl: "https://api.pid.peridotvault.com",
  solanaRpcUrl: "https://api.devnet.solana.com",
  onUnauthorized: async () => {
    const ok = await peridot.auth.refresh();
    if (!ok) {
      const url = await peridot.auth.login();
      if (url) window.location.assign(url);
    }
  },
});

const loginUrl = await peridot.auth.login(); // Google OAuth URL — navigate to it
if (loginUrl) window.location.assign(loginUrl); // first sign-up claims ifal@pid
await peridot.auth.logout();
await peridot.auth.refresh(); // true | "step-up" | false

await peridot.identity.me();                // { pid, status, role, createdAt }
await peridot.identity.credentials();       // list login credentials
await peridot.identity.unlinkCredential(id); // false if it's the last one

await peridot.profile.me();
await peridot.profile.update({ displayName: "PeridotPlayer" });

await peridot.wallet.createAccount(); // idempotent ensure → ChainAccount[]
await peridot.wallet.me();            // ChainAccount[] or ApiError (404 when none)
await peridot.wallet.activate();      // relayer-sponsored activation
await peridot.wallet.activation();    // live status view
await peridot.auth.pidAvailable("ifal"); // { available, pid }
```

Notes:

- Cookies are handled automatically (`credentials: "include"`).
- `onUnauthorized` fires only for protected-resource 401s — never for auth endpoints, so the
  refresh-on-401 pattern cannot recurse.
- The wallet is **record-only**: no key material is stored, generated, or returned. `me()`
  returns an `ApiError` (`404`) when the PID has no wallet yet.
- EVM permissions (WHITEPAPER.md §10) live in `@peridotvault/pid-evm` + `@peridotvault/pid-core`
  (`buildPermissionId`, grant/revoke/exec payloads, calldata builders) and the
  `v1/permissions` API — not in `sdk-js` wallet-client calls yet.
