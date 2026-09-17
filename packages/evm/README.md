# `@peridotvault/pid-evm`

EVM adapter for PeridotID counterfactual smart accounts (CREATE2).

- Address = `CREATE2(factory, salt=accountSeed, EIP-1167-proxy-of-implementation)`.
  Same factory + implementation on Monad / BSC / Arbitrum → one address everywhere.
- Authority = secp256r1 passkey `(x, y)`, set on `initialize` (rotation never moves it).
- V4 permissions (ADR 009, `contracts/V4_PERMISSIONS.md`): scoped P-256 session
  keys (`DOMAIN_PERM`, ops `0x10..0x16`), five scope kinds (nonfinancial + ETH /
  ERC-20 / ERC-721 / ERC-1155), constrained ERC-7579, owner-only ERC-1271.
  Builders: `buildPermissionId`, `buildGrantPayload`, `buildRevokePayload`,
  `buildPermExecPayload`, `buildExec7579Payload`, `buildModulePayload`,
  `build1271Challenge`, canonical transfer calldata, `DENIED_SELECTORS`;
  calldata via `EvmAdapter` (`buildGrantPermissionData`,
  `buildExecuteWithPermissionData`, …).
- No `web3.js`, no `viem` — pure `@peridotvault/pid-core` math + plain JSON-RPC reads.
  Deployment goes through `contracts/evm` (forge script / relayer) in phase 1.
