# Hierarchical routing

Arctis requires explicit `route.tsx` registration. This filename is an **Arctis convention**, not a native requirement of every router.

```text
pages/
├── route.tsx                 # Root aggregator
├── home.tsx                  # Standalone page
├── profile.tsx
├── settings/
│   ├── route.tsx             # Settings group registration
│   ├── index.tsx
│   └── permissions.tsx
└── dashboard/
    ├── route.tsx
    └── index.tsx
```

Group related pages; nest groups only when the route hierarchy needs it. Every group directory has its own `route.tsx`. The root `pages/route.tsx` registers its direct pages and immediate child groups, forming one route tree without competing registries or duplicated child implementations.

## Narrow import exception

- A `route.tsx` may import page components in **its own directory** for registration.
- A `route.tsx` may import `route.tsx` from an **immediate child group** for registration.
- A route file must not import a parent or sibling group, a page from another group, or a group's private implementation.
- Ordinary page components must not import other pages or any `route.tsx`.
- Route files must not share business logic or form route import cycles.

For example, `pages/settings/route.tsx → pages/settings/permissions.tsx` is valid; `pages/settings/route.tsx → pages/home.tsx` is invalid. A child group's registration flows upward only by the parent importing the child route file.

## Router integration

The conceptual registration is `root = register(own pages, child groups)`, with each child group registering only its own pages and children. Adapt the *registration code* to the selected router; keep the import relationships above.

For React Router's data mode, a group can export a route object while the root assembles child objects:

```tsx
// pages/settings/route.tsx
import type { RouteObject } from 'react-router';
import SettingsPage from './index';
import PermissionsPage from './permissions';

export const settingsRoute: RouteObject = {
  path: 'settings',
  children: [
    { index: true, Component: SettingsPage },
    { path: 'permissions', Component: PermissionsPage },
  ],
};
```

```tsx
// pages/route.tsx
import { createBrowserRouter } from 'react-router';
import HomePage from './home';
import { settingsRoute } from './settings/route';

export const router = createBrowserRouter([
  { path: '/', Component: HomePage },
  settingsRoute,
]);
```

These snippets illustrate import ownership and [documented route object APIs](https://reactrouter.com/start/data/routing); the application's actual route paths and router mode decide its final code.

- **React Router:** Route object `children` can express this hierarchy. Each `route.tsx` may export the route object(s) for its group; the root can assemble them and pass the resulting tree to the application's router setup. See [React Router route objects](https://reactrouter.com/start/data/routing).
- **TanStack Router:** Its code-based route tree can be assembled hierarchically with child routes. Its file-based mode has its own generated file conventions, so evaluate that compatibility before adopting it. Do not claim Arctis filenames are TanStack's required filenames. See [TanStack code-based routing](https://tanstack.com/router/latest/docs/routing/code-based-routing) and [file-based routing](https://tanstack.com/router/latest/docs/routing/file-based-routing).

If a framework requires incompatible filenames or generated route imports, report the conflict explicitly. Do not silently broaden page imports or pretend the framework follows Arctis naming.
