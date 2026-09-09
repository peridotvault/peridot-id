# `@peridotvault/pid-core`

Reusable PeridotID primitives — encoding, domain-separated hashes, WebAuthn
ceremonies, and client key custody. No redirects, no hosts, no app flow.

## Layers

- **`pid-core`** (this package) — primitives both layers share.
- **`@peridotvault/pid-solana`** — Solana chain adapter + instruction builders on top.
- **`@peridotvault/pid-sdk-js`** — direct PeridotID API client (first-party and
  third-party backends alike).
- **`@peridotvault/pid-react`** — public "Sign in with PeridotID" login UX
  (hosted redirects, prod defaults). Third-party apps only — the wallet never
  imports it.

Only `pid-core` and `pid-solana` may import `@solana/web3.js` (ADR 007 §8);
everything else goes through their surfaces.
