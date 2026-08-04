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

await peridot.profile.me();
await peridot.profile.update({ displayName: "PeridotPlayer" });
```

Notes:

- Cookies are handled automatically (`credentials: "include"`).
- `onUnauthorized` fires only for protected-resource 401s — never for auth endpoints, so the
  refresh-on-401 pattern cannot recurse.
