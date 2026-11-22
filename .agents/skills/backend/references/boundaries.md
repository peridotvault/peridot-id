# Backend boundaries

These are responsibility and dependency principles, not a mandatory folder layout.

- An HTTP adapter owns route registration, request parsing, status codes, and response shaping. Keep handlers thin.
- Validate untrusted request data before it reaches business operations. Validate other external input at its own trust boundary, including webhooks, queues, environment configuration, and database data when its shape is not guaranteed.
- Business operations express domain behavior. Prefer explicit inputs and dependencies over reaching into global state or Hono context.
- Data access owns persistence details. Keep SQL, ORM queries, or remote storage calls out of route registration.
- Avoid circular dependencies and unnecessary imports between domains. Pass data through explicit interfaces or orchestration where needed; do not create a generic shared module solely to hide coupling.
- Put genuinely reusable infrastructure in a shared location chosen by the application. Do not centralize domain-specific behavior merely because two modules call it.

For example, a Hono handler can validate transport input and call an injected operation:

```ts
type CreateAccountInput = { email: string };

function registerAccountRoutes(
  app: Hono,
  createAccount: (input: CreateAccountInput) => Promise<{ id: string }>,
) {
  app.post('/accounts', async (context) => {
    const body: unknown = await context.req.json();
    const input = parseCreateAccountInput(body); // Validate at the HTTP boundary.
    const account = await createAccount(input);
    return context.json(account, 201);
  });
}
```

`Hono` and `parseCreateAccountInput` stand for imports or definitions supplied by the host application. This example shows responsibility placement, not a prescribed file layout or validation library. Keep error mapping and authentication in the appropriate transport or boundary code for the project's conventions.
