# SDK

Browser SDK (`@peridot/sdk-js`). Full usage guide: see the public docs at `apps/docs`
(`content/docs/sdk.mdx`).

```ts
const peridot = Peridot({
  baseUrl: "https://api.peridot.id",
  onUnauthorized: async () => {
    const ok = await peridot.auth.refresh();
    if (!ok) await peridot.auth.login();
  },
});

await peridot.auth.login();
await peridot.auth.logout();
await peridot.auth.refresh(); // boolean

await peridot.identity.me();
await peridot.identity.credentials();         // list login credentials
await peridot.identity.unlinkCredential(id);  // boolean; false if it's the last one

await peridot.profile.me();
await peridot.profile.update({ username: "peridotplayer", displayName: "PeridotPlayer" });

await peridot.wallet.me();                    // wallet or ApiError (404 when none)
await peridot.wallet.create(address);         // wallet; second call returns the existing one
```

Notes:

- Cookies are handled automatically (`credentials: "include"`).
- `onUnauthorized` fires only for protected-resource 401s — never for auth endpoints, so the
  refresh-on-401 pattern cannot recurse.
- The wallet is **record-only**: no key material is stored, generated, or returned. `me()`
  returns an `ApiError` (`404`) when the PID has no wallet.
