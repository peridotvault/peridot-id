# ADR 009 — EVM Permission Layer (scoped session keys + constrained ERC-7579)

Status: accepted (EVM-only; pre-audit engineering — see §7).

Supersedes, for EVM only: the AA/session-keys deferral, PRD_v4
§1.2/§5.5/§31 and PRD_v5 §10 (session keys + EVM deferred). The SVM program is
unchanged: its PDA/CPI model needs a structurally different boundary, so
nothing here ports to Solana.

## Context

V3 gives one P-256 passkey total authority over an account's arbitrary
`(to, value, data)`. Any delegation bolted onto that shape (e.g. "a session
signs `execute`") would hand the session full owner power. The permission
layer therefore redesigns the boundary before delegating anything: the account
stays the permanent asset-owning account, and permissions are scoped
capabilities enforced inside the account (single audit point), never a second
wallet. Canonical spec: `contracts/WHITEPAPER.md` §10 (merged 2026-09-17; history in git).

## Decision

1. **P-256 session keys, domain-separated.** Session keys use the same curve as
   the owner (one WebAuthn/RIP-7212 verification path). OWNER vs PERMISSION
   separation is therefore `DOMAIN_PERM = "PID|EVM|PERMISSION|v1"` + op tags
   (`0x10` grant, `0x11` revoke, `0x12` perm-exec, `0x13/0x14` module
   install/uninstall, `0x15` 7579-exec, `0x16` 1271) + stored key-slot checks —
   never the curve. An owner signature cannot verify as a permission signature
   and vice versa.
2. **Full ERC-7579 interface with permanent prohibitions.** The account exposes
   `execute` / `executeFromExecutor` / `installModule` / `uninstallModule` /
   `isModuleInstalled` / `supportsExecutionMode` / `supportsModule` /
   `isValidSignatureWithSender`, plus owner-only ERC-1271. Permanently
   unsupported: delegatecall and batch execution modes, fallback/handler and
   hook modules. No `DELEGATECALL` opcode exists in the implementation
   (source-ban CI guard + runtime opcode-walk test). `PeridotPermissionExecutor`
   (type-2 only) is a thin forwarder; every check runs in the account.
3. **Single call per permission execution (v1).** No batch path, so smuggling a
   financial sub-call inside a benign batch is structurally impossible.
4. **Five scope kinds** (WHITEPAPER.md §10): nonfinancial (exact
   target+selector + financial-selector denylist, `value == 0`) and bounded
   financial (ETH / ERC-20 / ERC-721 / ERC-1155 via account-built canonical
   calls with per-tx + lifetime caps). Financial grants emit transfers, never
   approvals; the account never approves a session target.
5. **State-based revocation.** Owner-signed `revokePermission` flips state
   immediately; execution checks `revoked` every time. No session cooperation
   needed. Grants live ≤ 30 days (`MAX_PERMISSION_TTL`); every execution also
   carries a ≤600s deadline. Owner grants/revokes/installs consume the owner
   nonce; executions use a strict per-permission `seq`.
6. **ERC-1271 is owner-only with defensive rehash** (account + chain bound,
   cf. ERC-7739). Session signatures never verify as 1271; execution-context
   material is unusable outside its execution.

## Consequences

- New implementation + factory deploy = testnet address reset (V2 §8; nothing
   on mainnet). Salt scheme unchanged, so one PID still maps to one address.
- Owner-nonce space is shared by execute/rotate/grant/revoke/install/uninstall;
   wallets must track it across all owner operations.
- P-256 session verification costs RIP-7212/fallback gas per execution —
   accepted; session gas-griefing bounds are audit surface (§7).
- Backend holds no session keys (validation + id computation are pure);
   `POST /v1/permissions/grants/validate` + `GET /v1/permissions/denied-selectors`
   added to the OpenAPI spec.

## §7. Pre-audit status (blocking mainnet/immutability)

Proven (65 forge tests incl. 33 adversarial, anvil V4 loop, byte-exact SDK
vectors): §5-table guarantees for single-call scope, domain disjointness,
revocation immediacy, fee parity, no-delegatecall bytecode. Architectural
claim only: 7579 composition beyond the shipped executor, future
validators/caveats, 4337 mempool behavior, denylist evolution with token
standards, session gas-griefing bounds. An external human security audit must
cover these before any mainnet deploy or immutability action.

## References

- `contracts/WHITEPAPER.md` §10 (canonical), `contracts/evm/src/PeridotAccount.sol`,
  `contracts/evm/src/PeridotPermissionExecutor.sol`,
  `contracts/evm/test/PeridotPermission.t.sol`,
  `contracts/evm/test/anvil-v4-perm-e2e.mjs`.
- ERC-4337 / ERC-7579 / ERC-7715+7710 / ERC-1271 / ERC-7739 (primary sources).
- WHITEPAPER.md §§1–2, 10 (scope, authority model, executor constraint, one wallet with inside-scoping).
