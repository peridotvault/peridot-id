# `@peridotvault/pid-core`

Reusable PeridotID primitives — encoding, domain-separated hashes, WebAuthn
ceremonies, and client key custody. No redirects, no hosts, no app flow.

## Layers

- **`pid-core`** (this package) — primitives both layers share.
- **`@peridotvault/pid-solana`** — Solana chain adapter + instruction builders on top.
- **`@peridotvault/pid-evm`** — EVM adapter + V4 permission payload/calldata builders
  (`src/evm.ts`: `DOMAIN_EVM_PERM`, `OP_PERM`, `PERM_KIND`, `MODULE_TYPE`,
  `DENIED_SELECTORS`, canonical transfer builders).
- **`@peridotvault/pid-sdk-js`** — direct PeridotID API client (first-party and
  third-party apps alike; third parties delegate trust-critical actions to the
  hosted popup).

Only `pid-core` and `pid-solana` may import `@solana/web3.js` (web3.js layering rule);
everything else goes through their surfaces.
