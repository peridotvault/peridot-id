# Backend structure

## Established principles

Organize backend code by domain or module ownership. Keep HTTP registration and request handlers lightweight. Give validation, transport, business logic, and data access distinct responsibilities so each can be inspected and changed without unrelated edits. Keep shared infrastructure centralized only when it is genuinely reusable.

## Provisional conventions

Arctis Architecture has **not approved a fixed backend directory tree**, file naming scheme, layer count, or Hono-specific layout. The following is an illustrative separation of responsibilities, **not a required structure**:

```text
<existing module for accounts>/
  <HTTP route and handler code>
  <input validation code>
  <business operation code>
  <data access code>
```

In an existing project, inspect its conventions and place code where its owner and responsibility are clearest. A small endpoint may keep a short handler and validation near its route; a larger workflow may justify separate modules. Do not create files or folders merely to fill an imagined template.

For a Hono application, route registration can delegate to a domain operation after parsing and validating a request. The domain operation should not need Hono request or response objects. Data access should expose the operations that domain logic needs instead of forcing it to know transport details. The exact file paths remain a project decision.

Future Arctis decisions may define stricter conventions. Until then, do not enforce one example layout as policy. See [boundaries](boundaries.md) for the current dependency rules.
