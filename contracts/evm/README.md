# Peridot EVM contracts

Counterfactual smart accounts (CREATE2) — the EVM counterpart of the Solana
smart-account program. One address per `pidAccount.id` on every chain sharing
the factory (Monad / BSC / Arbitrum testnets in phase 1).

## Contracts

- `src/PeridotAccount.sol` — passkey-owned account (`secp256r1` authority set on
  `initialize`; `execute` / `updateAuthority` verify a WebAuthn assertion whose
  challenge is the domain-separated payload — the `auth.rs` binding in Solidity).
- `src/PeridotFactory.sol` — EIP-1167 proxy factory (`deploy` / `deployAndInit`
  / `predict`). Salt = `bytes32(accountIdToSeed32(accountId))`, so rotation
  never moves the address.
- `src/Base64Url.sol` — tiny base64url decoder for the challenge field.
- `lib/openzeppelin-contracts/` — vendored sources used (MIT): `proxy/Clones.sol`
  for deterministic proxies, `utils/cryptography/P256.sol` for signature
  verification (RIP-7212 precompile where present, pure Solidity fallback —
  low-S enforced either way). `lib/forge-std/` is a submodule.

## Commands

```sh
cd contracts/evm
forge build
forge test
```

## Deployment (same address on every chain)

1. Deploy the implementation identically everywhere. Cheapest: the keyless
   CREATE2 deployer (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, already on
   all three testnets) with the same bytecode → same address.
2. Run the factory script with that address on each chain:
   ```sh
   IMPLEMENTATION=0x... DEPLOYER_PRIVATE_KEY=0x... \
     forge script script/Deploy.s.sol --rpc-url <chain-rpc> --broadcast
   ```
   Deploying the factory through the same keyless deployer keeps the factory
   address identical too.
3. Put the outputs in `apps/api/.env`:
   `EVM_FACTORY_ADDRESS`, `EVM_IMPLEMENTATION_ADDRESS`, `EVM_RPC_URL_<ref>`,
   and optionally `EVM_RELAYER_SECRET` for API-driven `deployAndInit`.
   Without the relayer key, `POST /v1/accounts/:id/evm/:ref/activate` only
   confirms an out-of-band deployment to ACTIVE.

## Test vectors

`test/PeridotAccount.t.sol` happy path uses a real P-256 signature by privkey 1
(pubkey = generator G). To regenerate after touching the payload layout:

1. `forge test --match-test test_LogVector -vv` → prints payload `h`.
2. Sign `h` with P-256 privkey 1 (e.g. `@noble/curves`), normalize to low-S.
3. Paste `r`/`s` into `VEC_R`/`VEC_S`, set `VEC_READY = true`, `forge test`.
