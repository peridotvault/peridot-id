# Relying-party sessions: the thin-session recipe (Express/Nest)

> You don't run login. You run a **thin session**: PeridotID owns identity,
> your backend holds one opaque bearer per user and a dumb cookie. ~20 lines.

## The shape

```
browser --cookie(your httpOnly session id)--> your Express backend
your backend --Authorization: Bearer <peridot bearer>--> PeridotID API (reads only)
```

- The browser never sees the PeridotID bearer. Ever. It lives server-side.
- Your cookie maps to it (memory store, Redis, or your users table — see below).
- Every RP-backend request re-verifies against PeridotID (or a bounded cache).

## 1. Login (unchanged SSO)

```ts
// Frontend: open the PeridotID popup, get the one-time code.
import { Peridot } from "@peridotvault/pid-sdk-js";
const peridot = Peridot({ baseUrl: API_URL, popupBaseUrl: WALLET_URL, clientId: "pidapp_..." });
const { pidCode } = await peridot.auth.loginPopup({ clientId: "pidapp_..." });
// (popup falls back to a tab when blocked; loginTab() forces a tab.
//  Or full-page: const url = await peridot.auth.login({ clientId, returnTo }); location.assign(url);)
```

```ts
// Backend (Express): exchange once, store server-side, set your own cookie.
app.get("/auth/callback", async (req, res) => {
  const identity = await peridot.auth.exchange(String(req.query.pid_code), "https://mygame.dev/callback", "pidapp_...");
  if ("statusCode" in identity) return res.status(401).send("exchange failed");
  // identity = { pid, profile, credentials, accessToken, expiresIn, refreshToken, refreshExpiresIn }
  await store.save(sessionId(req), { pid: identity.pid, bearer: identity.accessToken, refresh: identity.refreshToken });
  res.cookie("sid", sessionId(req), { httpOnly: true, sameSite: "lax", secure: true });
  res.redirect("/");
});
```

Store **both** tokens; the refresh token is what keeps the session alive past the
bearer's 24h (see §2b and §4).

`pid_code` is single-use, 5-minute, bound to your `clientId`, and bound to the
exact `redirectUri` it was issued for (pass the URL you received the code on —
mismatch or omission is a 400).
(+ `clientSecret` when set — confidential clients must send it).

## 2. Authenticated reads (your whole session story)

```ts
// Middleware: attach the PeridotID identity to every request.
async function rpSession(req, res, next) {
  const sess = await store.get(req.cookies.sid);
  if (!sess?.bearer) return res.status(401).send("sign in");
  // Live-verify (fail-closed), or cache up to ~15 min (fail-open window — your call, §4).
  const me = await pidGet("/v1/identity/me", sess.bearer);
  if (!me) return res.status(401).send("re-authenticate");
  req.pid = me; // { pid } + your own domain row keyed by pid
  next();
}

async function pidGet(path, bearer) {
  const r = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${bearer}` } });
  return r.ok ? r.json() : null;
}
```

Reachable with this bearer (all GET, `scope: "read"`): `GET /v1/identity/me`,
`/v1/identity/credentials`, `/v1/profile/me`, `/v1/fiat/balance`,
`/v1/fiat/ledger`. Writes (transfer/withdraw/credential/profile) return
403 — money moves go through the PeridotID popup or your machine token, never
this bearer.

## 2b. Keeping the session alive (refresh)

The bearer lasts 24h. Before it expires, swap the stored refresh token for a
fresh pair — no browser, no user:

```ts
// Every ~12h (or on a 401 from /v1/identity/me), per stored session.
const next = await peridot.auth.refreshRp(sess.refresh);
if ("statusCode" in next) return null; // revoked / expired → make the user log in again
await store.save(sid, { pid: next.pid, bearer: next.accessToken, refresh: next.refreshToken }); // rotate: discard the old pair
```

The presented refresh token dies on use (rotation), so store the new one
immediately. A replayed old token is treated as theft: the whole app session
family is revoked and the user must log in again. Refreshing is sliding — as
long as your backend refreshes at least once every 30 days, the session lasts
indefinitely.

## 3. Your user row (still required)

Auth is stateless; your app isn't. Keep one row per user keyed by `pid`
(deal roles, streamer profiles, whatever is yours). PeridotID stores
`account/identity/balance/journal` — never your domain.

## 4. The six limits (read before promising anything to users)

1. **The bearer must stay server-side.** Anything in JS/localStorage is
   stealable via XSS. `httpOnly` cookie + server store, plus CSP. Non-negotiable.
2. **24h bearer, 30d sliding refresh.** `SSO_EXCHANGE_TOKEN_TTL` (`24h`,
   ANT-227) and `SSO_REFRESH_TOKEN_TTL` (`30d`, rotated per use). The bearer is
   non-sliding by design — rotate it with the refresh token (§2b). Miss the
   30d window and the user re-clicks login (one-tap consent if their PeridotID
   session is alive). Never log either token.
3. **Revoke ends refresh, not in-flight bearers.** "Disconnect app" (wallet →
   Settings → App connections) and revoking the app session in Settings kill
   the refresh family immediately; an already-issued bearer stays valid for
   reads until its 24h expiry. Scope contains the blast radius (reads only, no
   fund movement) — that is the mitigation.
4. **Verify-or-cache is your availability call.** Live-verify every request =
   PeridotID in your hot path (fail-closed when we're down, and deactivation
   honored immediately via the identity check). Caching identity up to ~15 min
   (the first-party access window) bounds deactivation lag. Pick per route;
   never cache past ~15 min.
5. **Logout doesn't propagate.** Our sign-out/revoke ends our session, not
   yours. Delete your own cookie server-side on your logout route.
6. **"Disconnect app" = "ask me again," not "kick them out."** Revoking a
   grant blocks one-tap `authorize`; a fresh full login heals it at exchange.

## 5. Bearer vs machine token (don't mix them up)

|                     | User bearer (this doc)       | Machine token (`POST /v1/auth/token`) |
| ------------------- | ---------------------------- | ------------------------------------- |
| Acts as             | one user (`sub` = their pid) | your app (`app` = your clientId)      |
| Sees                | that user's reads            | your app's own balance/powers         |
| Scope               | `read`, GET-only             | full app powers, AdminGuard-rejected  |
| Example             | show *their* balance         | read *your escrow* balance            |

## 6. Logout (yours)

```ts
app.post("/logout", async (req, res) => {
  await store.delete(req.cookies.sid);
  res.clearCookie("sid");
  res.send({ ok: true });
});
```

## What's deliberately missing (roadmap, in order)

1. `GET /v1/auth/userinfo` — stable RP contract instead of coupling to wallet endpoints.
2. JWKS — local JWT verification, breaking the hot-path coupling (§4).
3. Push revocation notifications (webhook) — today a revoked app learns it on its next refresh (≤30d idle) or on a 401.
