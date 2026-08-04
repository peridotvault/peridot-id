# Architecture

```text
Clients -> SDK -> Peridot ID API -> PostgreSQL
```

Refresh-token state lives in the `sessions` table — PostgreSQL is the only datastore.

Modules:
- auth
- identity
- profile

Repo:
```
apps/api
apps/docs
packages/sdk-js
packages/types
packages/openapi
```
