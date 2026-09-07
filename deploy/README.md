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
3. Google OAuth console: create OAuth 2.0 credentials with
   `https://api.pid.peridotvault.com/v1/auth/google/callback` as the redirect URI
   (redirect lands back on `app.pid.peridotvault.com` via CLIENT_SUCCESS_URL).
4. Firewall: 80/tcp and 443/tcp open.

## First deploy

```sh
ssh root@VPS
mkdir -p /opt/apps && cd /opt/apps
git clone https://github.com/peridotvault/peridot-id.git peridot-id && cd peridot-id

cp deploy/.env.main.example deploy/.env.main
$EDITOR deploy/.env.main        # JWT secrets, Google OAuth, relayer, DB URL

# Small VPS: ensure swap before the first build or it may OOM.
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

./deploy/db-init.sh main        # creates peridot_id db/role + runs migrations
./deploy/up.sh main             # builds api + web serially and starts them
```

Traefik auto-detects the two services, issues HTTPS via Let's Encrypt, and
routing goes live. No infra change.

## Update

```sh
# on the VPS (or via the GitHub Actions deploy workflow on push to main)
git pull && ./deploy/up.sh main
```

## Operate

```sh
./deploy/down.sh main
docker compose -f deploy/compose.yaml --env-file deploy/.env.main ps
docker compose -f deploy/compose.yaml --env-file deploy/.env.main logs -f api
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
- Solana is `devnet` for now (relayer funded on devnet). Mainnet later = new
  program deploy + funded relayer + `SOLANA_NETWORK=mainnet-beta`; the compose
  already passes network through from env.
- The GitHub Actions `deploy.yml` mirrors live2dev: on push to `main` it runs
  typecheck, then SSHes to the VPS and runs `./deploy/up.sh main`.