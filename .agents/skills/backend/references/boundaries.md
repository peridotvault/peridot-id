# Dependency boundaries

```text
api ──> schemas ──> generated
  ├──> services ──> repositories ──> db/generated
  └──> shared
```

## Permission matrix

| Importing path | Allowed local targets | Forbidden local targets |
| --- | --- | --- |
| `src/modules/<module>/api/` | own `schemas/`, own `services/`, `shared/`, `generated/`, external packages | own `repositories/`, `db/`, another module, `scripts/` behavior |
| `src/modules/<module>/schemas/` | own `schemas/`, `shared/`, `generated/`, external packages | own `api/`, `services/`, `repositories/`, another module |
| `src/modules/<module>/services/` | own `schemas/`, own `repositories/`, `shared/`, `generated/`, `integrations/` | own `api/`, `db/`, another module |
| `src/modules/<module>/repositories/` | own `schemas/`, own `repositories/`, `db/`, `generated/`, `shared/`, `integrations/` | own `api/`, own `services/`, another module |
| `src/shared/` | `shared/`, external packages | `modules/`, `db/`, feature-specific behavior |
| `src/bootstrap` files | modules, shared, db, generated, integrations | feature logic duplicated outside its module |
| `src/scripts/` | modules, shared, db, generated, integrations | being imported by API routes as an endpoint |

No circular dependencies are permitted.

## Ownership follows resolved identity

The check is based on resolved module identity, not import spelling. These do not bypass a boundary:

- relative paths such as `../../billing/services/billing.service.js`
- configured aliases such as `@/modules/billing/...`
- `import type`
- `export { ... } from` and `export * from`
- literal dynamic `import('...')`
- static `require('...')`
- barrel or intermediate files that re-export a forbidden owner

A dynamic import with a computed target cannot be resolved statically. The validator warns; inspect it manually. Symlinked source paths are rejected because they hide resolved ownership.

## Valid examples

```ts
// src/modules/users/api/users.ts
import { parseJsonBody } from "../../../shared/http/validation.js";
import { createUserSchema } from "../schemas/user.schema.js";
import { createUser } from "../services/users.service.js";
```

```ts
// src/modules/users/services/users.service.ts
import { HttpError } from "../../../shared/http/errors.js";
import { findUser } from "../repositories/users.repository.js";
import type { CreateUserInput } from "../schemas/user.schema.js";
```

```ts
// src/modules/users/repositories/users.repository.ts
import { prisma } from "../../../db/client.js";
import type { Prisma } from "../../../generated/prisma/client.js";
```

## Invalid examples

```ts
// src/modules/users/api/users.ts: skips service layer
import { findUser } from "../repositories/users.repository.js";

// src/modules/users/api/users.ts: reaches persistence directly
import { prisma } from "../../../db/client.js";

// src/modules/users/services/users.service.ts: imports transport
import { users } from "../api/users.js";

// src/modules/users/repositories/users.repository.ts: reverse layer
import { createUser } from "../services/users.service.js";

// src/modules/users/api/users.ts: cross-module dependency
import { bill } from "../../billing/services/billing.service.js";

// src/shared/http/errors.ts: shared depends on a module
import { findUser } from "../../modules/users/repositories/users.repository.js";
```

## Collaboration between modules

Do not import another module to reuse a rule. Move the smallest feature-independent contract or primitive into `shared/`, orchestrate from a root composition layer, or make one module own the workflow and expose a narrow service operation. Never move an entire business feature to `shared/` to make imports pass. Maintenance scripts may call module services because they are orchestration, not feature code.
