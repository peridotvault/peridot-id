# HTTP routing and transport

## Route composition

All feature endpoints live under `/api/v1`. `src/routes.ts` is the single composition point: it imports module routers and mounts them on one `apiV1` Hono instance, then mounts that instance under `/api/v1`.

```ts
const apiV1 = new Hono();
apiV1.route("/auth", auth);
apiV1.route("/users", users);
apiV1.route("/clients", clients);
// ...other module routers

const routes = new Hono();
routes.route("/api/v1", apiV1);
```

`src/app.ts` mounts `routes` at `/` after global middleware. Route registration files do not contain business rules or Prisma queries.

## Thin handlers

The `users` module is the reference pattern:

```ts
users.use("*", requireAuth);

users.get("/", requireRole(UserRole.ADMIN), async (c) => {
  const query = parseInput(userListQuerySchema, c.req.query());
  const { items, total } = await listUsers(query);
  return ok(c, items, { pagination: paginationMeta(query, total) });
});

users.post("/", requireRole(UserRole.ADMIN), async (c) => {
  const body = await parseJsonBody(c, createUserSchema);
  return ok(c, await createUser(body, c.get("user").id, c.get("requestId")), {}, 201);
});
```

Rules:

- Validate `c.req.query()`, `c.req.param()`, and JSON bodies with Zod before calling a service.
- Keep `HonoContext` out of services. Pass explicit values such as `actorId`, `requestId`, and validated input.
- Use shared `ok`/`fail` helpers for the response envelope. Return `204` with `c.body(null, 204)` for no-content actions.
- Apply `requireAuth` and `requireRole` in the API layer. Domain ownership checks that need loaded data belong in services, using explicit actor data.
- Use shared rate-limit helpers where a route needs them; do not invent per-route limiting logic.

## Error envelope and middleware

Errors use `{ "error": { "code": "...", "message": "..." } }` with optional details and `meta.requestId`. Services throw `HttpError` with stable codes; the global `errorHandler` maps it to HTTP. Never return raw exceptions, SQL, file paths, or secrets.

Global middleware provides request ID, one structured JSON access log per request, security headers, CORS from validated origins, and body limits. `/files/*` has its own body limit and cross-origin resource policy. Redact file tokens from logs.

## Health and documentation

- `GET /health/live` reports process liveness.
- `GET /health/ready` checks PostgreSQL and returns 503 when unavailable.
- `GET /openapi.json` and `GET /docs` are available outside production and 404 in production.
- `src/openapi.ts` is maintained alongside code. Response schemas and `responseShapes` are manual because services return selected Prisma shapes; update them whenever a response changes.
- OpenAPI coverage tests require every `/api/v1` route to be documented and validate real response shapes against the contract.

## Authentication

JWT bearer auth is part of the backend standard. Validate token expiry, inactive users, and `tokenVersion` mismatches. Login rate limiting, password reset, and deactivation are service responsibilities with API-layer guards. Store password hashes only; never log or return credentials.
