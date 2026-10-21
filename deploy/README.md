# PeridotID VPS deployment

Deploys `api` (NestJS) and `app` (Vite
static build) onto the Antigane infra
VPS. (Docs left the VPS in ANT-124: `apps/docs` is the Mintlify source,
board user deploys manually to `docs.peridot.id`.) Conforms to the infra platform contract (`infra/docs/application.md`): joins
the external `proxy` network, exposes internal ports only, owns its Traefik
labels. No infra repo changes are ever required.

## Prerequisites

1. VPS bootstrapped with the infra repo (Traefik on 80/443 + `proxy` network):
   `ssh root@VPS && cd /opt/infra && sudo bash bootstrap/bootstrap.sh`
2. DNS A-records pointing at the VPS IP (`76.13.16.183`):
   - `pid.peridotvault.com`
   - `app.pid.peridotvault.com`
   - `api.pid.peridotvault.com`
   - `sandbox.pid.peridotvault.com` (sandbox workspace)
   - `app.sandbox.pid.peridotvault.com` (sandbox wallet)
   - `api.sandbox.pid.peridotvault.com` (sandbox API)
   - `api.peridot.id` (ANT-99 dual-serve API — same stack, same router, old hosts stay live)
   - `sandbox-api.peridot.id` (ANT-99 dual-serve sandbox API)
   - (wallet `peridot.id` / `sandbox.peridot.id`, docs `docs.peridot.id`, dashboard
     `dashboard.peridot.id` are frontend turf — ANT-117 — with DevOps TLS/DNS in ANT-118)
3. Google OAuth console: register **both** redirect URIs on the OAuth 2.0 client
   (old stays until every integration moves; cutover flips which one the stack advertises):
   - `https://api.pid.peridotvault.com/v1/auth/google/callback` (current `GOOGLE_CALLBACK_URL`)
   - `https://api.peridot.id/v1/auth/google/callback` (post-cutover `GOOGLE_CALLBACK_URL`)
   - sandbox client: `https://api.sandbox.pid.peridotvault.com/v1/auth/google/callback`
     + `https://sandbox-api.peridot.id/v1/auth/google/callback`
   (redirect lands back on the wallet via CLIENT_SUCCESS_URL).
4. Firewall: 80/tcp and 443/tcp open.

## First deploy (Infisical Cloud)

Secrets live in Infisical Cloud, project `peridot-id-uf-w9`
(`51f99bb1-16c8-4b74-be1f-52657e066a93`), envs `dev` / `test` / `main`:

- `/apps/api` — runtime secrets (`DATABASE_URL`, `JWT_*`, `GOOGLE_*`, `DOKU_*`, `PID_*`, …)
- `/apps/wallet` — `VITE_*` (public build args)

Docs are Mintlify-hosted since ANT-124 (`apps/docs` is the Mintlify source, board user
deploys manually) — no VPS docs service, no build args, no secrets, no env.

There is no `/deploy` folder — it only duplicated the above. Delete it in the
Infisical UI for every env if it still exists. Deploy meta (`ENV_SUFFIX`,
`NAMESPACE`) is hardcoded in `up.sh`, not stored as secrets.

```sh
ssh root@VPS
mkdir -p /opt/apps && cd /opt/apps
git clone https://github.com/peridotvault/peridot-id.git peridot-id && cd peridot-id

# One-time: persist the machine-identity creds for this host (0600 root).
# The identity is project-scoped (read) on /apps/{api,wallet}; up.sh
# exchanges these for a short-lived token on every run.
mkdir -p /etc/peridot-id
umask 077
cat > /etc/peridot-id/infisical.env <<'EOF'
INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=<universal-auth-client-id>
INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=<client-secret>
EOF
chmod 600 /etc/peridot-id/infisical.env

# Small VPS: ensure swap before the first build or it may OOM.
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

./deploy/db-init.sh main        # creates peridot_id db/role + runs migrations
./deploy/up.sh main             # pulls secrets via `infisical run`, builds api + app (+ dashboard)
```

No `deploy/.env.*` exists on the VPS — secrets are fetched from Infisical at
deploy time. `INFISICAL_ENABLED=0 ./deploy/up.sh main` still reads a local
`deploy/.env.main` for offline/local use only.

> Plan note: the org currently allows a **single** machine identity, so both the
> prod and sandbox hosts share one project-scoped identity (each can read every
> env). Split into per-env identities once the Infisical plan allows for tighter
> isolation.

Traefik auto-detects the two services, issues HTTPS via Let's Encrypt, and
routing goes live. No infra change.

## Sandbox (test) stack — DOKU sandbox, no real money

A second, fully separate stack for testing apps (public + internal). Same code,
**separate** DB (`peridot_id_test`), DOKU **sandbox** credentials, JWT secrets,
cookie domain, and app registrations. Deployed from the `test` branch.

```sh
ssh root@VPS
cd /opt/apps/peridot-id
git clone https://github.com/peridotvault/peridot-id.git peridot-id-test
cd peridot-id-test
# Persist the same project-scoped identity as prod (see the plan note above):
mkdir -p /etc/peridot-id && umask 077
cat > /etc/peridot-id/infisical.env <<'EOF'
INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=<universal-auth-client-id>
INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=<client-secret>
EOF
chmod 600 /etc/peridot-id/infisical.env
./deploy/db-init.sh test   # creates peridot_id_test + migrations
./deploy/up.sh test
```

Domains: `sandbox.pid.peridotvault.com`, `app.sandbox.pid.peridotvault.com`,
`api.sandbox.pid.peridotvault.com` **plus** `sandbox-api.peridot.id` (dual-serve,
same VPS, separate Traefik routers via `NAMESPACE=-test` / `ENV_SUFFIX=sandbox.` /
`NEW_API_HOST`). Old hosts stay live — removal is a later board-ordered task.

**Google OAuth:** the sandbox reuses the production Google client, so add
`https://api.sandbox.pid.peridotvault.com/v1/auth/google/callback` to that
client's authorized redirect URIs. Never add localhost URIs to the prod client.
Dual-serve adds `https://sandbox-api.peridot.id/v1/auth/google/callback` (and
`https://api.peridot.id/v1/auth/google/callback` for main) the same way.

## Domain cutover checklist (ANT-99 — operator steps in Infisical, not code)

Code is dual-serve-ready on this branch; going live on the new names is config:

- [ ] DNS + TLS live for `api.peridot.id` / `sandbox-api.peridot.id` (Trevor, ANT-118)
- [ ] Infisical `/apps/api` (main): append new origins to `CORS_ORIGINS`
      (e.g. `https://peridot.id,https://dashboard.peridot.id,https://docs.peridot.id`;
      keep every old origin until integrations move)
- [ ] Infisical `/apps/api` (main): set `COOKIE_DOMAIN` empty (host-only — the compose
      default). Do NOT keep `.peridotvault.com`: browsers drop `Domain=` cookies set
      from `api.peridot.id`, breaking sessions there. Security review: Tobias, ANT-119.
      Note: pre-cutover `Domain`-scoped cookies linger in browsers but hold revoked
      server-side sessions after logout (fail closed); login issues fresh host-only cookies.
- [ ] `GOOGLE_CALLBACK_URL` stays on the old callback until the new redirect URI is
      registered + verified; flip after (same key names, values differ per env).
- [ ] `CLIENT_SUCCESS_URL` stays on the old wallet until frontend flips (Thomas, ANT-117).
- [ ] Intentionally UNCHANGED: `WEBAUTHN_RP_ID` (passkeys are bound to the RP ID —
      changing it orphans existing credentials; needs its own migration plan, never a
      silent flip), `EMAIL_FROM=no-reply@peridotvault.com` (Brevo verified sender),
      `DOKU_WEBHOOK_URL` (re-register with DOKU only when API canonical host moves —
      Troy, ANT-120), SDK `PRESETS` defaults (still old hosts; flip only after DNS live —
      Thomas, ANT-117).

**Google OAuth:** the sandbox reuses the production Google client, so add
`https://api.sandbox.pid.peridotvault.com/v1/auth/google/callback` to that
client's authorized redirect URIs. Never add localhost URIs to the prod client.
**WebAuthn** uses `sandbox.pid.peridotvault.com` as RP id → passkeys are isolated
per environment.

### Sandbox SLA + faucet (ANT-287 sandbox MVP, DevOps ANT-290)

**No prod SLA for the sandbox in MVP — it is a best-effort test bed.**
Same VPS as prod (noisy-neighbor risk), no uptime target, deploys and
maintenance may interrupt it without notice. Never point production traffic
or real money at it; DOKU runs in sandbox mode there so real money can never
move anyway.

**Faucet (instant test money).** The API registers
`POST /v1/fiat/test-credit` ONLY when `PID_FAUCET_ENABLED` is exactly
`"true"` (fail-closed: unset/anything-else ⇒ route absent ⇒ 404, zero
ledger writes):

- Sandbox: `PID_FAUCET_ENABLED=true` (`deploy/.env.test.example` + Infisical
  test env `/apps/api`). Mints land on the internal fiat ledger via
  `fiat_issue` with `source='faucet'` (backend contract, ANT-289).
- Production: `PID_FAUCET_ENABLED=false`, set explicitly in
  `deploy/.env.main.example` + Infisical main env. Verify after every deploy
  touching fiat: `POST /v1/fiat/test-credit` on prod ⇒ 404.
- Caps (proposed, CTO confirms via ANT-287 OQ-1): per-call max Rp50.000,
  Rp100.000 + 10 calls/identity/day, backend-hardcoded.
- Abuse alert: `deploy/alerts/faucet-abuse-check.sh` — cron it (sandbox
  `*/15`, production `*/5` with `ALERT_ENV=production` for the prod-zero
  invariant). See `deploy/alerts/README.md`.

**Dashboard env switch.** Both stacks bake `VITE_OTHER_WORKSPACE_URL` at
build time (`up.sh` defaults: sandbox → `https://dashboard.peridot.id`,
prod → `https://sandbox-dashboard.peridot.id`; overridable via
`DASHBOARD_OTHER_WORKSPACE_URL` env or Infisical `/apps/api|/apps/wallet`
same key). If the var is ever unset, the topbar switch hides — the Frontend
derivation fallback (ANT-291 AC-D1) removes that single point of failure;
until it lands, keep the var set in both deploys.

## Update

```sh
# on the VPS (or via the GitHub Actions deploy workflow)
git pull && ./deploy/up.sh main      # production (branch main)
git pull && ./deploy/up.sh test      # sandbox (branch test)
```

## Operate

```sh
./deploy/down.sh main
docker ps --filter name=peridot-id-api
docker logs -f peridot-id-api-1
```

## URLs

| Service   | Old URL (kept live, dual-serve) | New canonical (ANT-99) |
|-----------|----------------------------------|------------------------|
| Wallet    | https://app.pid.peridotvault.com | https://peridot.id |
| API       | https://api.pid.peridotvault.com | https://api.peridot.id |
| API docs  | https://api.pid.peridotvault.com/docs | https://api.peridot.id/docs |
| Docs      | https://pid.peridotvault.com/docs | Mintlify-hosted `docs.peridot.id` (board decision 2026-10-19; user deploys manually — NOT on this VPS) |
| Dashboard | https://pid.peridotvault.com/workspace | https://dashboard.peridot.id |

Sandbox mirrors with the `sandbox.*` prefix on the sandbox VPS (`107.173.130.7`):
`sandbox.peridot.id`, `sandbox-api.peridot.id`,
`sandbox-dashboard.peridot.id`, plus single Mintlify docs `docs.peridot.id` (no sandbox docs host).
Old sandbox hosts
(`app.sandbox.pid.peridotvault.com`, `api.sandbox.pid.peridotvault.com`,
`sandbox.pid.peridotvault.com`) stay live.

## peridot.id cutover (ANT-99 / ANT-118, DevOps-owned)

Additive-only change: new `Host()` rules sit alongside the old ones on the same
routers (same Traefik, same `letsencrypt` certresolver). Old hosts keep serving
byte-identical traffic — no redirects off old hosts. Rollback is a plain revert
+ `./deploy/up.sh <env>` (old rules are never edited, only appended to).

### DNS checklist (registrar: Hostinger — human action, then verify)

One-label rule (ANT-143): every host is exactly one DNS label under
`peridot.id` — Cloudflare Universal SSL (`*.peridot.id`) never covers nested
names like `sandbox.api.peridot.id` (edge 443 handshake failure, verified
2026-10-20), so nested names are never used. Keep this rule for all future hosts.

6 A-records (board marked DONE 2026-10-19; `docs.*` intentionally have NO
records — Mintlify hosts docs, user deploys manually, see table above).
Apex = `A`, no CNAME at apex:

| # | Host | Type | Value | Purpose |
|---|------|------|-------|---------|
| 1 | `peridot.id` | A | `76.13.16.183` (prod VPS) | wallet apex |
| 2 | `api.peridot.id` | A | `76.13.16.183` | API (router: ANT-116) |
| 3 | `dashboard.peridot.id` | A | `76.13.16.183` | dashboard (new service) |
| 4 | `sandbox.peridot.id` | A | `107.173.130.7` (sandbox VPS) | sandbox wallet |
| 5 | `sandbox-api.peridot.id` | A | `107.173.130.7` | sandbox API |
| 6 | `sandbox-dashboard.peridot.id` | A | `107.173.130.7` | sandbox dashboard |

`www.peridot.id` already resolves to parking — leave it until brand decides
(redirect vs site); out of scope here.

Verify after DNS propagates (Traefik issues certs automatically on first
request via the existing `letsencrypt` resolver — allow ~2 min):

```sh
for h in peridot.id api.peridot.id dashboard.peridot.id \
         sandbox.peridot.id sandbox-api.peridot.id \
         sandbox-dashboard.peridot.id; do
  echo "== $h"; dig +short $h A
  curl -sk -o /dev/null -w "%{http_code}\n" --max-time 10 https://$h/
done
curl -sk https://api.peridot.id/v1/health        # {"status":"ok"}
curl -sk https://sandbox-api.peridot.id/v1/health # {"status":"ok"} (sandbox VPS)
```

Old-host regression (must stay 200, no 301):

```sh
for h in app.pid.peridotvault.com api.pid.peridotvault.com pid.peridotvault.com \
         app.sandbox.pid.peridotvault.com api.sandbox.pid.peridotvault.com \
         sandbox.pid.peridotvault.com; do
  curl -sk -o /dev/null -w "$h %{http_code}\n" --max-time 10 https://$h/
done
```

### What this stack change does (and does not do)

- `deploy/compose.yaml`: wallet router also answers `peridot.id` /
  `sandbox.peridot.id`; **new** `dashboard` service (nginx `:3001`,
  `Dockerfile.dashboard`) answers `dashboard.peridot.id` /
  `sandbox-dashboard.peridot.id`. Docs router REMOVED (ANT-124: `apps/docs` is now
  the Mintlify source; Mintlify hosts `docs.peridot.id`, board decision 2026-10-19 —
  sequencing warning in `compose.yaml`: do not run `up.sh` until Mintlify is live).
  Remaining old rules byte-identical.
- `deploy/up.sh`: per-env deploy-meta defaults (`NEW_WALLET_HOST`,
  `NEW_DASHBOARD_HOST`, `DASHBOARD_API_URL`,
  `DASHBOARD_POPUP_URL`, `DASHBOARD_PID_ENV`, `DASHBOARD_OTHER_WORKSPACE_URL`).
  Pre-set env or Infisical values win; API dual-serve var `NEW_API_HOST` stays
  owned by ANT-116.
- NOT in this change (sibling turf, tracked separately): API router dual-serve
  + `COOKIE_DOMAIN`/`CORS_ORIGINS`/`WEBAUTHN_*`/`GOOGLE_CALLBACK_URL` env flips
  (ANT-116, needs Security review); wallet/dashboard build-arg cutover to new hosts
  (ANT-117); Mintlify docs migration (new child task → FrontendEngineer, user
  deploys docs manually); Google OAuth redirect-URI registration; `@peridot.id` sender
  domain (stays as-is per spec).
- Monitoring: per-`Host` request/error/latency split must exist in dashboards
  from day 0 of the new rules; alert on TLS issuance failure for any of the 6
  VPS-hosted names (spec NFRs).

## Database

Uses the shared infra Postgres server (`infra` `services` profile) — one server,
many app databases. `db-init.sh` calls `/opt/infra/scripts/createdb.sh` to create
the `peridot_id` role + database, then runs `prisma migrate deploy`.

## Notes

- Images build from source on the VPS (serially via `./deploy/up.sh`: api, app, dashboard); the
  app's `VITE_API_URL` is baked in at build via a Docker build arg. Changing it
  requires a rebuild.
- Solana is `devnet` for now (relayer funded on devnet). The Solana chain, its
  RPC endpoints, and the smart-account program id live in the DB chain registry
  (edited in the workspace admin), not in env. Mainnet later = register the
  mainnet chain + contracts there and fund the relayer on it.
- The GitHub Actions `deploy.yml` mirrors live2dev: on push to `main` it runs
  typecheck, then SSHes to the VPS and runs `./deploy/up.sh main`.