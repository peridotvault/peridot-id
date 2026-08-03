# Architecture

```text
Clients -> SDK -> Peridot ID API -> PostgreSQL
                          -> Redis
```

Modules:
- auth
- identity
- profile

Repo:
```
apps/api
packages/sdk-js
packages/types
packages/openapi
```
