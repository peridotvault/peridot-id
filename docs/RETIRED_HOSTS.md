# Retired hosts (ANT-400 hard cutover)

Canonical hosts are `peridot.id` only. The six retired names below must resolve
to nothing after DNS withdrawal (NXDOMAIN / no A record — connection refused).

> Scope note (ANT-426): this file lives in `docs/` **on purpose**. The CI
> retired-host guard (`.github/workflows/ci.yml`, Login split guard step)
> bans `peridotvault.com` in infra-owned surfaces (`deploy/`, Dockerfiles,
> `docker-compose.yml`, `ci.yml` — sole exception: the Brevo `EMAIL_FROM`
> sender note). Keeping the verify loop here keeps `deploy/README.md`
> host-free and the guard green.

Retired-host expectation (after DNS withdrawal):

```sh
for h in pid.peridotvault.com app.pid.peridotvault.com api.pid.peridotvault.com \
         sandbox.pid.peridotvault.com app.sandbox.pid.peridotvault.com \
         api.sandbox.pid.peridotvault.com; do
  echo "== $h"; dig +short $h A
done
# every retired name above must print NOTHING (NXDOMAIN / no A record after DNS withdrawal).
```
