# Peridot EVM contracts

Counterfactual smart accounts (CREATE2) — the EVM counterpart of the Solana
smart-account program. Salt = `sha256(pid)`, so one identity owns one address per
`(factory, implementation)` and rotation never moves it.

V4 adds the permission layer (`contracts/WHITEPAPER.md` §10, canonical): scoped
P-256 session keys + constrained ERC-7579 + owner-only ERC-1271, with V3 payloads
frozen. Nothing in V4 ports to Solana.

## Contracts

- `src/PeridotAccount.sol` — passkey-owned account, V3 authorization + fee schema
  (`contracts/WHITEPAPER.md` §§2–3, canonical): the `secp256r1` authority is set on
  the passkey-bound `initialize`; `execute` / `updateAuthority` verify a WebAuthn
  assertion whose challenge is the V3 domain-separated payload (op-tagged, account-
  and chain-bound, policy-bound, no amounts). `execute` mirrors SVM `withdraw_sol`:
  the submitter attests `networkFee`, the contract sanity-checks it against measured
  gas (`GasAnomaly`), recomputes `protocolFee` from policy, and splits relayerFee →
  `msg.sender`, protocolFee → factory vault; `initialize` does the same for
  activation (SVM `activate` parity, pre-funded counterfactual).
  V4 adds, under `DOMAIN_PERM = "PID|EVM|PERMISSION|v1"` (ops `0x10..0x16`):
  owner-signed `grantPermission` / `revokePermission` (consume the owner nonce,
  ≤30d grant TTL), session-signed single-call `executeWithPermission` (strict
  per-permission `seq`, exact scope match, spend caps), owner-gated
  `installModule` / `uninstallModule` (validator/executor types only),
  ERC-7579 `execute` (auth inside `executionCalldata`) /
  `executeFromExecutor` (`onlyExecutorModule`), and owner-only `isValidSignature`
  with account+chain defensive rehash. A transient `_locked` mutex covers every
  untrusted-call path. There is intentionally NO `delegatecall` anywhere in this
  file (CI-enforced); `supportsExecutionMode` is true for single `call` only.
- `src/PeridotPermissionExecutor.sol` — ERC-7579 type-2 module, thin forwarder to
  `executeFromExecutor` (enforces nothing itself; installed by the owner).
- `src/PeridotFactory.sol` — EIP-1167 proxy factory (`deployAndInit` / `predict`;
  there is intentionally NO bare `deploy` — a deployed-but-uninitialized proxy is a
  squat vector) AND canonical revenue vault (`receive()` accumulates protocol fees;
  `addAdmin` / `removeAdmin` / `withdrawRevenue`, admin-only, floor ≥1 admin, with
  events; no path touches user accounts). Salt = `bytes32(pidToSeed32(pid))`, so
  rotation never moves the address. `deployAndInit` is permissionless but
  user-authorized (ANT-610: any submitter — official relayer, volunteer, or the
  user self-relaying — may call with a valid user authorization; passkey binds
  salt, authority, policy, deadline, chainid, factory). No creation allowlist
  remains: `deploysPaused` (admin-only, default off) is the narrow kill-switch
  for creation only. Constructor: `(implementation, admins[])`.
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
2. Sign `h` as a RAW prehashed P-256 digest with privkey 1 (NOT via a
   hash-then-sign API — e.g. python `ecdsa.SigningKey.sign_digest`), normalize
   to low-S. See `test/vectors/README.md`.
3. Paste `r`/`s` into `VEC_ACT_*` / `VEC_EXE_*` / `VEC_ROT_*`, set `VEC_READY = true`,
   `forge test` (29 tests).

## Localnet

```sh
cd contracts/evm
anvil &   # localhost:8545, funded default keys
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6bb9d3777c8a7f2383c692335d6779b7f1549d21b7 \
ADMINS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

First run deploys implementation + factory and prints `IMPLEMENTATION`, `FACTORY`,
`INIT_CODE_HASH` — note them. Creation is permissionless (ANT-610): any submitter
may call `deployAndInit` with a valid user authorization — nothing about the
submitter is authorized: authority, fee policy and recipients are fixed by the
user's signed authorization + the factory's immutables, and the fee split pays
`networkFee` to the actual caller. The admin-only `setDeploysPaused` is the narrow
creation kill-switch (default off; spend + revenue paths unaffected). `ADMINS`
(required, comma-separated) seeds the revenue administrators —
same value on every chain; the factory itself accumulates protocol revenue
(`withdrawRevenue`, admin-only). (Localnet deploys against anvil's own chain id;
API wiring below is for testnet and up.) Wire the API (DB-first, ANT-193 —
chain config lives in the `chains` registry, fee minima in the chain fee
policy; both are dashboard-managed via the admin API, never `.env`):

```sh
EVM_FACTORY_ADDRESS=<factory>
EVM_IMPLEMENTATION_ADDRESS=<implementation>
```

Without the relayer key, `POST /v1/account/evm/:chainRef/activate` only confirms
an out-of-band deployment to ACTIVE (set the per-chain key via the dashboard
admin endpoint `PUT /v1/admin/chains/:id/evm-relayer` — the key is DB-managed
in `evm_relayer_keys`, never an env var — to enable API-driven `deployAndInit`,
which now requires the user's V3 activation assertion in the body).
Protocol revenue lands in the factory vault itself (no treasury address anywhere);
`requiredWei`/`networkFeeWei` cover the attested network cost so READY means funded.

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
    IMPLEMENTATION=0x... ADMINS=0x... DEPLOYER_PRIVATE_KEY=0x... \
      forge script script/Deploy.s.sol --rpc-url $EVM_RPC_URL_97 --broadcast
    ```
   Deploying the factory through the same keyless deployer keeps the factory
   address identical too. Verify both addresses on each chain's explorer.
3. Register the outputs in the `chains` registry (dashboard admin API —
   chains list, contract upserts for `factory` / `account_implementation`,
   RPC URLs per chain). The `db:seed` env vars (`EVM_FACTORY_ADDRESS`,
   `EVM_IMPLEMENTATION_ADDRESS`, `EVM_RPC_URL_<ref>`) are bootstrap-only for
   fresh local DBs; the registry rows are the source of truth afterwards.
   Chain fee minima come from the chain fee policy (dashboard admin API
   `POST /v1/admin/fee-policies`, public read `GET /v1/fee-policy`) —
   `serviceFee = max(networkFee × bps / 10_000, MIN_FEE[chain])`.

## Mainnet

Target chains TBD — the flow is identical to testnet: same bytecode everywhere,
same deployer discipline, verify on each explorer, register RPCs + factory in
the `chains` registry (dashboard admin API, never env). Key management: deployer keys live in a
hardware wallet/keystore and pass via env only — never committed, never pasted
into chat/logs.

## Notes

- `out/`, `cache/`, `broadcast/` are gitignored. Broadcast receipts contain no
  secrets, but deployer keys only ever travel via `DEPLOYER_PRIVATE_KEY` env.
- `deriveEvmSmartAccountAddress` (`@peridotvault/pid-evm`) must stay byte-identical
  to `PeridotFactory` salt handling — the forge parity test (`test_LogCreate2Parity`)
  is the cross-check.
