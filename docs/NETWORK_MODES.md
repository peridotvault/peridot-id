# Network modes — mainnet & testnet

One frontend, two backends, one identity.

| | Mainnet | Testnet |
|---|---|---|
| API host | `api.peridot.id` | `testnet-api.peridot.id` |
| Database | prod `peridot_id` | separate test DB |
| PID, passkey, profile, device, session | ✅ the only copy | ❌ none (identity routes are proxied) |
| Chain accounts, authorities, intents, tx | ✅ | ✅ (devnet; may be reset) |
| Fiat / money | real (DOKU production) | test (DOKU sandbox + faucet route) |
| Level / XP / task completion | ✅ persistent | ✅ own copy, resettable |
| App registry (`pid_apps`, keys, origins, fees) | ✅ | ✅ separate |

Frontend hosts are single: wallet `peridot.id`, dashboard `dashboard.peridot.id`.
The two stacks are separate machines: main stack (API + wallet + dashboard) and
the test stack (API + its own DB) on another VPS. They share only the origin
pair and the `.peridot.id` cookie domain — no shared database, no shared disk.
Mode (`mainnet` | `testnet`) is a user-visible switch in the wallet (Settings)
and in the dashboard sidebar. Switching stores `pid_network_mode` and **reloads**
— the API origin is fixed per page load, so no client, cache, or request ever
straddles two networks.

## How identity stays single

The testnet API has no identity tables. Instead:

- Browser session cookies carry `COOKIE_DOMAIN=.peridot.id` (both stacks), so
  the one session minted by mainnet is sent to `testnet-api.peridot.id` too.
- Identity routes (`/v1/auth`, `/v1/identity`, `/v1/pids`, `/v1/profile`,
  `/v1/credentials`) on the testnet stack are **forwarded verbatim** to the
  mainnet API (`common/identity-proxy.ts`) — the testnet DB can never mint a
  PID, credential, or session.
- Every other authenticated testnet request is verified by **introspection**
  against mainnet (`GET /v1/auth/introspect`, cached 60s in
  `common/network-auth.ts`). No shared JWT secret; the mainnet origin is
  derived from the stack's own `API_URL` (`testnet-api` → `api`; a `sandbox-` prefix
  is still stripped so a self-hosted stack can name its host either way).
- 13+ tables reference `identity.pid`, so the testnet stack materialises a bare
  shadow `Identity` row (pid only) on first write — `prisma/pid-ref.ts`.

Consequences: one passkey, one login, and the same PID on both networks.
Mainnet down ⇒ testnet login unavailable (testnet data stays intact).

## Apps on the testnet stack

The app registry is per-network (`pid_apps` lives in each stack's own DB, and
the dashboard lists both networks side by side with a `testnet` / `mainnet`
badge). A testnet app is therefore unknown to mainnet — which is why the two
app routes that only need the registry are served **locally** on the testnet
stack instead of being forwarded:

- `GET /v1/auth/app-info` — the consent card (name, logo, login methods).
- `POST /v1/auth/token` — the machine token, signed with the testnet stack's own
  `JWT_ACCESS_SECRET`. Mainnet introspection cannot validate it (different
  secret, no such app), so `common/jwt-auth.guard.ts` verifies the local
  signature first and only falls back to introspection for user sessions
  (`common/local-app-token.ts`, `pid-app` audience only).

Everything else that names an app stays forwarded, because it needs identity
that only mainnet owns. For those calls the proxy **drops the app binding**
when the `clientId` belongs to a testnet app (`identity-proxy.ts`,
`APP_BOUND_ROUTES`): `login`, `authorize`, `passkey/finish`, `email/verify`, and
`exchange` then run as a first-party login, with `returnTo` validated against
the operator allowlist (loopback always allowed). The developer experience is
the same as mainnet — set `PID_ENV` (`sandbox` for testnet) and the SDK points
at the right stack; no second registration, no "Invalid client" on credentials
they never touched. A testnet app is still a *separate* record from any mainnet
app: nothing about it is written to the mainnet DB.

Consequence worth knowing: a testnet login is not app-bound, so per-app
`loginMethods` switches and the unverified-app consent gate apply to mainnet
apps only. Fees, escrow, XP and app-user data for a testnet app are unaffected —
they resolve the app from the testnet registry, on the testnet stack.

## Cross-network signing

Mode = which network's data is on screen. The signing target is the chain the
action belongs to, so a testnet action from a mainnet-mode screen is allowed
and always carries a `TESTNET — test money only` banner. Fiat is the exception:
test money and real money never share a screen, so the wallet gates the fiat
screens (`Topup`, `FiatTransfer`) off in testnet mode. The test stack still
keeps its fiat tables and registers the faucet route
(`PID_FAUCET_ENABLED=true`) for API-level testing; there is no wallet UI for it.

## Testnet reset policy (safe: testnet only)

Truncatable at any time (e.g. yearly):
`chain_accounts`, `authorities`, `intents`, `transactions`, `security_events`,
`relayer_broadcast`, `fiat_*` (ledger, provider tx, webhook, account),
`user_xp_state`, `xp_task_completion`, `xp_ledger_entry`,
`wallet_auth_challenges`, `sso_codes`, `sso_grants`, shadow `identity` rows.

Never reset: `chains`, `chain_contracts`, `tokens`, `chain_fee_policy`,
`fiat_fee_policy`, `fiat_tax_setting`, `xp_policy_version`,
`xp_level_threshold`, `xp_task`, `xp_quota`, `pid_apps` (+ keys/origins).

Devnet chain state survives a DB reset, so the API must **re-discover** chain
accounts from the chain on the next login instead of trusting the cleared DB.

## Deploy

- Main stack: API + wallet + dashboard (`--profile web`).
- Test stack: **API + DB only** (`deploy/compose.yaml` profiles) — its own VPS.
- One new env per stack: `PID_NETWORK=mainnet|testnet`. Nothing else.
- Boot fails loudly when the flag disagrees with `API_URL` (`networkConsistencyError`):
  testnet needs a `testnet-*` host, mainnet must not have one.
- `deploy/.env.main*` must keep `DOKU_MODE=production` and no
  `PID_FAUCET_ENABLED` (the faucet route is not registered on mainnet).
