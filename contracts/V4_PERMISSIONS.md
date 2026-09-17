# PeridotID V4 Permission Layer (canonical, EVM-only)

Status: **canonical spec** alongside `V2_AUTHORIZATION.md` (V3 paths frozen).
V4 adds a scoped permission layer + ERC-7579 surface to `PeridotAccount`
without changing any V3 payload, signature, or fee rule. Nothing here ports to
Solana: the PDA/CPI model needs its own boundary (see plan review, Sep 2026).

Core invariant (extends V3, never weaken):

> A permission is a scoped capability, never a second wallet. The account stays
> the permanent asset-owning account. Target allowlisting is a UX/discovery
> feature only — every guarantee below holds against a fully adversarial,
> previously-unseen target contract.

## 1. Roles and cryptographic distinction

- **OWNER** = the P-256 passkey (`authorityX/Y`), V3 paths unchanged.
- **PERMISSION key** = a P-256 session key registered per permission. Same curve
  as the owner by product choice, so OWNER vs PERMISSION separation rests
  **entirely** on domain separation — this is load-bearing:
  - Owner payloads: `DOMAIN_V3 = "PID|EVM|SMART_ACCOUNT|v3"` + ops
    `0x01/0x03/0x05` (frozen) and `DOMAIN_PERM` owner ops below.
  - Permission payloads: `DOMAIN_PERM = "PID|EVM|PERMISSION|v1"` + ops
    `0x10..0x16`. An owner signature can never verify as a permission
    signature and vice versa (challenge binds the domain).
  - Key-slot check: owner fns verify against `authorityX/Y`; permission exec
    verifies against the stored `sessions[permissionId]` key. Cross-use reverts
    (`Unauthorized` — proven by `test_AdvOwnerSigInvalidOnPermPath`,
    `test_AdvSessionSigInvalidOnOwnerPaths`, `test_AdvGrantNeedsOwnerSig`).

## 2. Payloads (`keccak256`, `abi.encodePacked` order)

Common: `chainid uint256`, `account address`, `nonce/seq uint64`,
`deadline uint64` (TTL ≤ 600s, `MAX_TTL`), `feePolicyVersion uint16` (rate only).

- `permissionId = keccak256(DOMAIN_PERM ‖ chainid ‖ account ‖ sessionX ‖
  sessionY ‖ kind:u8 ‖ target ‖ selector:b4 ‖ token ‖ to ‖ nftId:u256 ‖
  validUntil:u64 ‖ salt)` — binds chain + account + session + full scope +
  expiry + owner salt (re-grant uniqueness).
- `grant = keccak256(DOMAIN_PERM ‖ 0x10 ‖ chainid ‖ account ‖ permissionId ‖
  sessionX ‖ sessionY ‖ kind ‖ target ‖ selector ‖ token ‖ to ‖ perTxCap:u256 ‖
  totalLimit:u256 ‖ nftId ‖ validAfter:u64 ‖ validUntil:u64 ‖ nonce ‖ deadline)`
  — owner-signed, consumes the owner nonce (ordered with execute/rotate).
- `revoke = keccak256(DOMAIN_PERM ‖ 0x11 ‖ chainid ‖ account ‖ permissionId ‖
  nonce ‖ deadline)` — owner-signed, immediate state flip.
- `permExec = keccak256(DOMAIN_PERM ‖ 0x12 ‖ chainid ‖ account ‖ permissionId ‖
  seq ‖ target ‖ value:u256 ‖ keccak256(data) ‖ deadline ‖ feePolicyVersion)`
  — session-signed. `seq` must equal stored `seq` (strict, then `seq++`).
- `install/uninstall = keccak256(DOMAIN_PERM ‖ 0x13/0x14 ‖ chainid ‖ account ‖
  moduleType:u256 ‖ module ‖ keccak256(initData) ‖ nonce ‖ deadline)`.
- `exec7579 = keccak256(DOMAIN_PERM ‖ 0x15 ‖ chainid ‖ account ‖ nonce ‖ target ‖
  value ‖ keccak256(data) ‖ deadline ‖ feePolicyVersion)`.
- `1271 challenge = keccak256(DOMAIN_V3 ‖ 0x16 ‖ chainid ‖ account ‖ hash)` —
  defensive rehash (account + chain bound; cf. ERC-7739/Coinbase replaySafeHash).

Replay protection: owner nonce (grants/revokes/installs), per-permission `seq`
(executions), chainid + account in every payload, short deadline on every
action, long `validUntil ≤ now + 30d` (`MAX_PERMISSION_TTL`) on grants.
Revocation is state-based (`revoked` flag checked on every execution) and needs
no session cooperation. Proven by `test_AdvReplaySameSeqFails`,
`test_AdvCrossChainReplayFails`, `test_AdvRevokeIsImmediateAndOwnerOnly`,
`test_AdvExpiredPermissionFails`, `test_AdvLongTtlRejected`,
`test_AdvGrantTtlBounded`, `test_AdvGrantIdBinding`.

## 3. Scope kinds (single call per execution — no batch in v1)

1. **NONFINANCIAL** `{target, selector}`: exactly one call shape. `value == 0`,
   `target` must equal the granted target (never account/factory/zero),
   calldata selector must equal the granted selector, and the selector must not
   be in the denylist (§5). The granted target may be unknown/unaudited at grant
   time — safety comes from §5, not from auditing it.
2. **ETH** `{to, perTxCap, totalLimit}`: account-built value transfer only
   (`data` empty, `target == to`, `0 < value ≤ perTxCap`,
   `spent + value ≤ totalLimit`).
3. **ERC-20** `{token, to, perTxCap, totalLimit}`: `data` must be exactly
   `transfer(to, amount)` on `token` with `to` and caps as above.
4. **ERC-721** `{token(collection), to, nftId}`: `transferFrom` or 3-arg
   `safeTransferFrom` with `from == account`, exact `to`/`id`, one-shot
   (`spent` 0→1). Bytes-overload rejected in v1.
5. **ERC-1155** `{token, to, nftId, perTxCap, totalLimit(amount units)}`:
   `safeTransferFrom(account, to, id, amount, "")` — empty extra data only.

Spend accounting (`spent`, `seq`) updates **before** the untrusted call
(checks-effects-interactions). Fee settlement equals V3 (attested `networkFee`
sanity-bounded by `GasAnomaly`, `protocolFee` recomputed, relayer →
fee recipient, protocol → factory). Proven by `test_Perm*` happy paths,
`test_PermFeeSettlement`, `test_AdvFeeSanityOnPermPath`.

## 4. ERC-7579 surface (full interface, constrained modes)

Implemented: `accountId` (`"peridot.pid-account.v4"`), `supportsModule`
(true for validator=1/executor=2 only), `supportsExecutionMode` (true **only**
for `MODE_SINGLE_DEFAULT = bytes32(0)`), `isModuleInstalled`,
`installModule`/`uninstallModule` (owner-signed, types 1–2 only, effects first,
`onInstall`/`onUninstall` callback last, revert on init failure),
`execute(bytes32,bytes)` (owner auth packed inside `executionCalldata` per
`Exec7579Args` — the standard leaves validator selection to the account),
`executeFromExecutor(bytes32,bytes)` (`onlyExecutorModule`, decodes
`PermExecArgs`, all checks run in the account), `isValidSignatureWithSender`.
`PeridotPermissionExecutor` (type-2 only) is a thin forwarder and enforces
nothing by itself. `ENTRY_POINT` is reserved zero (4337 later).
Permanently unsupported: **delegatecall modes, batch modes, fallback/handler
and hook modules** (`UnsupportedExecutionMode`/`UnsupportedModuleType`).
Proven by `test_AdvDelegatecallAndBatchModesRejected`,
`test_AdvModuleTypeBoundaries`, `test_AdvExecutorCallNeedsModule`,
`test_PermExecutorPath`.

## 5. Adversarial guarantees (executor calls untrusted contracts)

| Threat | Enforcement (all on-chain) | Proven by |
|---|---|---|
| Direct theft (ETH/20/721/1155) | value/caps/recipient/token/id bound per §3; financial calls canonical-constructed, never forwarded | `test_Perm*`, `test_AdvCannot*` |
| Approval creation (`approve`, `setApprovalForAll`, `permit`, Permit2) | denylist at grant **and** execution; financial paths accept only transfer-shaped calldata | `test_AdvCannotGrantApproveSelector`, `test_AdvCannotSneakApproveThroughTransferGrant` |
| Privilege escalation via self-call | `target == account/factory` reverts on permission paths | `test_AdvCannotTargetSelf` |
| Reentrant escalation (`updateAuthority`, `installModule`, re-exec) | transient `_locked` mutex on every untrusted-call path; reentry needs a fresh signature it lacks | `test_AdvReentryInto{Rotate,PermExec,Install}Fails` |
| `delegatecall` escalation | **no `DELEGATECALL` opcode in implementation** (source ban CI-enforced + runtime opcode-walk test); modes rejected | `test_AdvNoDelegatecallInImplementation`, CI `Delegatecall ban guard` |
| Generic ERC-1271 signing from sessions | `isValidSignature` accepts **owner only** over the rehashed challenge; session/exec-context material never verifies; cross-account replay fails | `test_Adv1271OwnerOkSessionRejected`, `test_Adv1271NoCrossAccountReplay` |
| Replay / extension / post-revoke use | §2 | replay/revoke/expiry tests |
| Relayer abuse | permission submission is permissionless like V3; fee rate (not amount) is signed; sanity bound + reconciliation unchanged | `test_PermFeeSettlement`, `test_AdvFeeSanityOnPermPath` |

What the denylist does NOT do: it is a second layer. Primary containment is
exact target+selector match (nonfinancial) and canonical call construction
(financial) plus no-standing-allowance hygiene (the account never approves a
session target; financial grants emit transfers, never approvals).

## 6. Preserved invariants

One PID → one CREATE2 address (same salt/factory discipline; new
implementation/factory deploy = testnet reset per V2 §8, nothing on mainnet);
rotation never moves the address; passkey stays owner authority; relayer stays
untrusted; ERC-4337 remains possible (`ENTRY_POINT` reservation, nonce/mode
discipline, gap discipline — `__gap` 44→38 documented in storage).

## 7. Proven vs architectural claim (pre-audit)

Proven (evidence: 65 forge tests incl. 33 permission/adversarial, anvil V4 E2E,
byte-exact SDK vectors, 9 backend specs): the table in §5 for single-call
scope; OWNER/PERMISSION domain disjointness; revocation immediacy; fee
settlement parity; no-delegatecall in shipped bytecode; SDK↔contract interop.
Architectural claim (needs external human audit before immutability): 7579
module-composition safety beyond the shipped executor; future validator/caveat
designs; P-256 session gas-griefing bounds; 4337 mempool behavior; token
standards evolution for the denylist. **Do not deploy to mainnet or burn
upgrade authority on the basis of this work alone.**
