# `@peridotvault/pid-stellar`

PeridotID Stellar testnet helpers (Phase-1 P1, ANT-703). Testnet-only, not audited.

- `src/scope.mjs` — canonical scope builder + `scopeHash`, byte-identical to
  `contracts/stellar/phase0-experiments/src/rules.rs` (`scope_canonical` / `scope_hash`).
  Golden parity vectors in `test/scope.test.mjs` are pinned by the Rust side.
- `src/network.mjs` — F1 network pre-check: `networkId(passphrase)` derives
  the host-truth id (`env.ledger().network_id()`); `precheckNetwork(rpc, expected)`
  throws `BadNetwork` (refuse to sign) on mismatch. Wire `rpc` to RPC `getNetwork`.

```sh
npm test   # node --test, no dependencies
```
