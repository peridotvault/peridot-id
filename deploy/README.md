# PeridotID VPS deployment

Deploys `api` (NestJS), `docs` (Next.js homepage/marketing), and `app` (Expo web
static export) onto the Antigane infra
VPS. Conforms to the infra platform contract (`infra/docs/application.md`): joins
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
3. Google OAuth console: create OAuth 2.0 credentials with
   `https://api.pid.peridotvault.com/v1/auth/google/callback` as the redirect URI
   (redirect lands back on `app.pid.peridotvault.com` via CLIENT_SUCCESS_URL).
4. Firewall: 80/tcp and 443/tcp open.

## First deploy (Infisical Cloud)

Secrets live in Infisical Cloud, project `peridot-id-uf-w9`
(`51f99bb1-16c8-4b74-be1f-52657e066a93`), envs `dev` / `test` / `main`:

- `/apps/api` — runtime secrets (`DATABASE_URL`, `JWT_*`, `GOOGLE_*`, `DOKU_*`, `PID_*`, …)
- `/apps/web` — `NEXT_PUBLIC_*` (public build args)
- `/apps/wallet` — `EXPO_PUBLIC_*` (public build args)

There is no `/deploy` folder — it only duplicated the above. Delete it in the
Infisical UI for every env if it still exists. Deploy meta (`ENV_SUFFIX`,
`NAMESPACE`) is hardcoded in `up.sh`, not stored as secrets.

```sh
ssh root@VPS
mkdir -p /opt/apps && cd /opt/apps
git clone https://github.com/peridotvault/peridot-id.git peridot-id && cd peridot-id

# One-time: persist the machine-identity creds for this host (0600 root).
# The identity is project-scoped (read) on /apps/{api,web,wallet}; up.sh
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
./deploy/up.sh main             # pulls secrets via `infisical run`, builds api + web + app
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
`api.sandbox.pid.peridotvault.com` (same VPS, separate Traefik routers via
`NAMESPACE=-test` / `ENV_SUFFIX=sandbox.`).

**Google OAuth:** the sandbox reuses the production Google client, so add
`https://api.sandbox.pid.peridotvault.com/v1/auth/google/callback` to that
client's authorized redirect URIs. Never add localhost URIs to the prod client.
**WebAuthn** uses `sandbox.pid.peridotvault.com` as RP id → passkeys are isolated
per environment.

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

| Service   | URL |
|-----------|-----|
| Docs/home | https://pid.peridotvault.com |
| App       | https://app.pid.peridotvault.com |
| API       | https://api.pid.peridotvault.com |
| API docs  | https://api.pid.peridotvault.com/docs |

## Database

Uses the shared infra Postgres server (`infra` `services` profile) — one server,
many app databases. `db-init.sh` calls `/opt/infra/scripts/createdb.sh` to create
the `peridot_id` role + database, then runs `prisma migrate deploy`.

## Notes

- Images build from source on the VPS (serially via `./deploy/up.sh`: api, docs, app); the
  app's `EXPO_PUBLIC_API_URL` is baked in at build via a Docker build arg. Changing it
  requires a rebuild.
- Solana is `devnet` for now (relayer funded on devnet). The Solana chain, its
  RPC endpoints, and the smart-account program id live in the DB chain registry
  (edited in the workspace admin), not in env. Mainnet later = register the
  mainnet chain + contracts there and fund the relayer on it.
- The GitHub Actions `deploy.yml` mirrors live2dev: on push to `main` it runs
  typecheck, then SSHes to the VPS and runs `./deploy/up.sh main`.