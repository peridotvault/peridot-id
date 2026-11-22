# Dependency boundaries

```text
pages ──> feat ──> shared
   └────────────────> shared
```

| Importing module | Allowed application modules | Forbidden application modules |
| --- | --- | --- |
| Ordinary `pages/` page | Any `feat/` or `shared/` module | Every other `pages/` module |
| `pages/**/route.tsx` | `feat/`, `shared/`, direct pages in its own group, and immediate child `route.tsx` files for registration | Parent/sibling routes, other groups' pages, and other page internals |
| `feat/<name>/` | Its own feature and `shared/` | Other features and all `pages/` |
| `shared/` | Other `shared/` modules | All `feat/` and `pages/` modules |

External dependencies are permitted in each layer when compatible with its runtime and platform. No circular dependencies are permitted, even within one feature or within `shared/`.

Ownership follows **resolved module identity**, not import spelling. Relative imports, `@/` or other path aliases, type-only imports, re-exports, barrels, literal dynamic imports, and intermediate modules cannot bypass a boundary. A barrel in `feat/auth` that re-exports `feat/user` still creates a forbidden dependency. Alternative aliases resolving to the same file have the same owner. See [enforcement](enforcement.md) for static detection limits.

## Valid examples

```ts
// pages/home.tsx
import { Hero } from '@/feat/home/components/Hero';
import { Button } from '@/shared/components/Button';

// feat/auth/hooks/useLogin.ts
import { login } from '../services/login';
import { formatDate } from '@/shared/utils/formatDate';

// shared/hooks/useDebounce.ts
import { timer } from '../utils/timer';

// pages/settings/route.tsx
import SettingsPage from './index';
import PermissionsPage from './permissions';
```

The root `pages/route.tsx` may import `./settings/route` and its own `./home` page.

## Invalid examples

```ts
// feat/auth/hooks/useLogin.ts: sibling feature, even through an alias
import { getUser } from '@/feat/user/services/user';

// feat/auth/index.ts: re-export still crosses feature ownership
export { getUser } from '../user/services/user';

// feat/user/types.ts: type-only dependency still crosses features
import type { AuthSession } from '../auth/types';

// feat/user/load.ts: literal dynamic import still crosses features
const auth = await import('../auth/services/session');

// shared/components/Button.tsx: shared cannot depend on a feature
import { useLogin } from '@/feat/auth/hooks/useLogin';

// feat/auth/services/login.ts: feature cannot depend on a page
import HomePage from '@/pages/home';

// pages/home.tsx: ordinary page cannot import another page or a route
import ProfilePage from './profile';
import { routes } from './route';

// pages/settings/route.tsx: unrelated group page
import HomePage from '../home';
```

When two features need to collaborate, pass data through page composition, place coordination in a clearly owned higher-level feature, or extract a genuinely feature-independent contract or primitive to `shared/`. Reconsider boundaries when ownership is unclear. Never shift domain behavior into `shared/` merely to make imports pass.
