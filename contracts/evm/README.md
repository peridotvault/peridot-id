# Peridot EVM contracts

Counterfactual smart accounts (CREATE2) — the EVM counterpart of the Solana
smart-account program. Salt = `sha256(pid)`, so one identity owns one address per
`(factory, implementation)` and rotation never moves it.

## Contracts

- `src/PeridotAccount.sol` — passkey-owned account (`secp256r1` authority set on
  `initialize`; `execute` / `updateAuthority` verify a WebAuthn assertion whose
  challenge is the domain-separated payload — the `auth.rs` binding in Solidity).
- `src/PeridotFactory.sol` — EIP-1167 proxy factory (`deploy` / `deployAndInit`
  / `predict`). Salt = `bytes32(pidToSeed32(pid))`, so rotation
  never moves the address.
- `src/Base64Url.sol` — tiny base64url decoder for the challenge field.
- `lib/openzeppelin-contracts/` — vendored sources used (MIT): `proxy/Clones.sol`
  for deterministic proxies, `utils/cryptography/P256.sol` for signature
  verification (RIP-7212 precompile where present, pure Solidity fallback —
  low-S enforced either way). `lib/forge-std/` is a submodule.

## Prereqs

Foundry (`forge`, `cast`, `anvil`). All commands run from `contracts/evm` —
chain state and build output stay here, never at repo root.

## Build & tests

```sh
cd contracts/evm
forge build
forge test
```

## Test vectors

`test/PeridotAccount.t.sol` happy path uses a real P-256 signature by privkey 1
(pubkey = generator G). To regenerate after touching the payload layout:

1. `forge test --match-test test_LogVector -vv` → prints payload `h`.
2. Sign `h` with P-256 privkey 1 (e.g. `@noble/curves`), normalize to low-S.
3. Paste `r`/`s` into `VEC_R`/`VEC_S`, set `VEC_READY = true`, `forge test`.

## Localnet

```sh
cd contracts/evm
anvil &   # localhost:8545, funded default keys
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6bb9d3777c8a7f2383c692335d6779b7f1549d21b7 \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

First run deploys implementation + factory and prints `IMPLEMENTATION`, `FACTORY`,
`INIT_CODE_HASH` — note them. (Localnet deploys against anvil's own chain id;
API wiring below is for testnet and up.) Wire the API (`apps/api/.env`):

```sh
EVM_FACTORY_ADDRESS=<factory>
EVM_IMPLEMENTATION_ADDRESS=<implementation>
```

Without the relayer key, `POST /v1/account/evm/:chainRef/activate` only confirms
an out-of-band deployment to ACTIVE (`EVM_RELAYER_SECRET` enables API-driven
`deployAndInit`).

## Testnet

Phase-1 chains — same flow on each, same addresses everywhere:

| Chain | ref | RPC env |
|---|---|---|
| Monad Testnet | `10143` | `EVM_RPC_URL_10143` |
| BSC Testnet | `97` | `EVM_RPC_URL_97` |
| Arbitrum Sepolia | `421614` | `EVM_RPC_URL_421614` |
| Base Sepolia | `84532` | `EVM_RPC_URL_84532` (`EVM_RPC_URL` fallback) |

1. Deploy the implementation identically everywhere. Cheapest: the keyless
   CREATE2 deployer (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, already on
   all four testnets) with the same bytecode → same address.
2. Run the factory script with that address on each chain:
   ```sh
   IMPLEMENTATION=0x... DEPLOYER_PRIVATE_KEY=0x... \
     forge script script/Deploy.s.sol --rpc-url $EVM_RPC_URL_97 --broadcast
   ```
   Deploying the factory through the same keyless deployer keeps the factory
   address identical too. Verify both addresses on each chain's explorer.
3. Put the outputs in `apps/api/.env` (`EVM_FACTORY_ADDRESS`,
   `EVM_IMPLEMENTATION_ADDRESS`, one `EVM_RPC_URL_<ref>` per chain) and seed them
   into the `chains` registry (admin API or `db:seed` env).

## Mainnet

Target chains TBD — the flow is identical to testnet: same bytecode everywhere,
same deployer discipline, verify on each explorer, register RPCs + factory in
API env and the `chains` registry. Key management: deployer keys live in a
hardware wallet/keystore and pass via env only — never committed, never pasted
into chat/logs.

## Notes

- `out/`, `cache/`, `broadcast/` are gitignored. Broadcast receipts contain no
  secrets, but deployer keys only ever travel via `DEPLOYER_PRIVATE_KEY` env.
- `deriveEvmSmartAccountAddress` (`@peridotvault/pid-evm`) must stay byte-identical
  to `PeridotFactory` salt handling — the forge parity test (`test_LogCreate2Parity`)
  is the cross-check.
