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
2. DNS A-records (prod VPS `76.13.16.183`, sandbox VPS `107.173.130.7`):
   - `peridot.id` → `76.13.16.183` (wallet apex)
   - `api.peridot.id` → `76.13.16.183` (API)
   - `dashboard.peridot.id` → `76.13.16.183` (dashboard)
   - `sandbox.peridot.id` → `107.173.130.7` (sandbox wallet)
   - `sandbox-api.peridot.id` → `107.173.130.7` (sandbox API)
   - `sandbox-dashboard.peridot.id` → `107.173.130.7` (sandbox dashboard)
   (`docs.peridot.id` is Mintlify-hosted — no VPS records. Retired-host records
   are removed at cutover.)
3. Google OAuth console: register the redirect URIs on the OAuth 2.0 client
   (one client shared by prod + sandbox):
   - `https://api.peridot.id/v1/auth/google/callback`
   - `https://sandbox-api.peridot.id/v1/auth/google/callback`
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

Domains: `sandbox.peridot.id`, `sandbox-api.peridot.id`,
`sandbox-dashboard.peridot.id` (same VPS, separate Traefik routers via
`NAMESPACE=-test` / `NEW_API_HOST`). Single Mintlify docs `docs.peridot.id`
(no sandbox docs host).

**Google OAuth:** the sandbox reuses the production Google client, so add
`https://sandbox-api.peridot.id/v1/auth/google/callback` to that
client's authorized redirect URIs. Never add localhost URIs to the prod client.

## Domain cutover checklist (ANT-405 — operator steps in Infisical, not code)

Traffic is peridot.id-only on this branch; going live is config + DNS:

- [ ] DNS A-records live for all 6 VPS hosts (human, registrar Hostinger — table below)
- [ ] TLS: Traefik `letsencrypt` resolver issues per-host certs on first request
      (~2 min) — verify with the commands below
- [ ] Infisical `/apps/api` (main + test): `CORS_ORIGINS` holds the canonical
      `https://peridot.id,https://dashboard.peridot.id,https://docs.peridot.id`
      (+ sandbox mirrors on test); no retired origins
- [ ] Infisical `/apps/api` (main + test): `COOKIE_DOMAIN` empty (host-only — the compose
      default). Browsers drop `Domain=` cookies set from a host they don't belong
      to, breaking sessions there. Security review: Tobias, ANT-119.
- [ ] `GOOGLE_CALLBACK_URL` = canonical API callback per env (register both URIs first)
- [ ] `WALLET_URL` / `CLIENT_SUCCESS_URL` = canonical wallet per env (Thomas, ANT-117)
- [ ] Still HUMAN-GATED (not flipped by this change): `EMAIL_FROM=no-reply@peridotvault.com`
      (Brevo verified sender — a new sender domain needs human verification first),
      `DOKU_WEBHOOK_URL` (re-register with DOKU only when the API canonical host moves —
      Troy, ANT-120), `WEBAUTHN_RP_ID` (passkeys are bound to the RP ID — changing it
      orphans existing credentials; needs its own migration plan, never a silent flip).

**Google OAuth:** the sandbox reuses the production Google client — both callback
URIs above are registered on it. Never add localhost URIs to the prod client.
**WebAuthn** RP ID derives from the wallet host (`peridot.id` /
`sandbox.peridot.id`) → passkeys are isolated per environment. Existing
credentials bound to a retired RP ID need their own migration plan (Tyler +
Security review) — never flip silently.

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
- **Prod lock (board order 2026-10-21):** `deploy/up.sh main` refuses to
  deploy when the rendered config shows any value but `false`
  (`deploy/faucet-preflight.sh`; CI-enforced repo contract). Even a mistaken
  `true` in the main env aborts the deploy before any container builds.
- Caps (proposed, CTO confirms via ANT-287 OQ-1): per-call max Rp50.000,
  Rp100.000 + 10 calls/identity/day, backend-hardcoded.
- Abuse alert: installed automatically by `up.sh` (`deploy/alerts/install.sh`;
  sandbox `*/15`, production `*/5` with `ALERT_ENV=production` for the prod-zero
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

## Rollback (ANT-385: tag-switch, no rebuild)

Every build is tagged `:<short-sha>` (default `TAG`) and aliased to `:latest`;
each deploy appends `<timestamp> env=<env> sha=<sha> tag=<tag>` to
`deploy/.deploys.log` (gitignored, lives on the VPS). Roll back by
re-running `up.sh` against a recorded tag — containers restart on the
existing images, nothing rebuilds:

```sh
tail -5 deploy/.deploys.log                      # pick the last-good tag
TAG=<prev-sha> SKIP_BUILD=1 ./deploy/up.sh main  # tag-switch rollback
curl -sk https://api.peridot.id/v1/health        # {"status":"ok","db":"up","sha":"<prev-sha>"}
```

`GIT_SHA` is baked into the API image and reported by `/v1/health`, so the
running version is always observable. Crons (`install.sh`) are idempotent —
re-running install on rollback is safe.

## Operate

```sh
./deploy/down.sh main
docker ps --filter name=peridot-id-api
docker logs -f peridot-id-api-1
```

## URLs

| Service   | Canonical URL (ANT-400 hard cutover) |
|-----------|--------------------------------------|
| Wallet    | https://peridot.id |
| API       | https://api.peridot.id |
| API docs  | https://api.peridot.id/docs |
| Docs      | Mintlify-hosted `docs.peridot.id` (board decision 2026-10-19; user deploys manually — NOT on this VPS) |
| Dashboard | https://dashboard.peridot.id |

Sandbox mirrors on the sandbox VPS (`107.173.130.7`):
`sandbox.peridot.id`, `sandbox-api.peridot.id`,
`sandbox-dashboard.peridot.id`, plus single Mintlify docs `docs.peridot.id` (no sandbox docs host).

## peridot.id hard cutover (ANT-400 / ANT-405, DevOps-owned)

Each Traefik router matches exactly one canonical host (same Traefik, same
`letsencrypt` certresolver). Retired hosts are removed from every rule —
requests to them no longer route once DNS is withdrawn. Rollback is a plain
`git revert` + `./deploy/up.sh <env>` (previous deploy log line has the tag:
`TAG=<prev-sha> SKIP_BUILD=1 ./deploy/up.sh <env>`).

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

Retired-host expectation (after DNS withdrawal — connection refused / NXDOMAIN):

```sh
for h in peridot.id api.peridot.id dashboard.peridot.id \
         sandbox.peridot.id sandbox-api.peridot.id \
         sandbox-dashboard.peridot.id; do
  curl -sk -o /dev/null -w "$h %{http_code}\n" --max-time 10 https://$h/
done
# every line above must print 200; the retired names must NOT resolve.
```

### What this stack change does (and does not do)

- `deploy/compose.yaml`: each router matches its canonical host only
  (`api.peridot.id` / `sandbox-api.peridot.id`, `peridot.id` /
  `sandbox.peridot.id`, `dashboard.peridot.id` /
  `sandbox-dashboard.peridot.id`). The retired-docs redirect router is REMOVED
  (its match host is decommissioned; Mintlify serves `docs.peridot.id`).
- `deploy/.env.{main,test}.example`: all service URLs are canonical peridot.id;
  no retired examples remain.
- `deploy/up.sh`: per-env deploy-meta defaults only (`NEW_API_HOST`,
  `NEW_WALLET_HOST`, `NEW_DASHBOARD_HOST`, `DASHBOARD_API_URL`,
  `DASHBOARD_POPUP_URL`, `DASHBOARD_PID_ENV`, `DASHBOARD_OTHER_WORKSPACE_URL`).
  Pre-set env or Infisical values win. `NEW_DOCS_HOST` is gone with the redirect.
- `Dockerfile.app` / `Dockerfile.dashboard`: build-arg defaults + CSP
  `connect-src` are canonical-host only.
- `.github/workflows/ci.yml`: retired-host guard fails the build on any
  reintroduction in infra surfaces (scoped — app/docs turf excluded).
- NOT in this change (sibling turf, tracked separately): Infisical value flips
  (`CORS_ORIGINS`/`COOKIE_DOMAIN`/`GOOGLE_CALLBACK_URL`/`WALLET_URL` — operator
  steps above); app-source host strings (Tyler/Thomas tickets); SDK preset
  defaults (already canonical with a runtime retired-host warning — Thomas);
  Mintlify docs deploy (board user, manual); Google OAuth redirect-URI
  registration (human); sender-domain migration (human-gated, see checklist).
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