# `@peridotvault/pid-evm`

EVM adapter for PeridotID counterfactual smart accounts (CREATE2).

- Address = `CREATE2(factory, salt=accountSeed, EIP-1167-proxy-of-implementation)`.
  Same factory + implementation on Monad / BSC / Arbitrum → one address everywhere.
- Authority = secp256r1 passkey `(x, y)`, set on `initialize` (rotation never moves it).
- No `web3.js`, no `viem` — pure `@peridotvault/pid-core` math + plain JSON-RPC reads.
  Deployment goes through `contracts/evm` (forge script / relayer) in phase 1.
