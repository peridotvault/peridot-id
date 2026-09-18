# PeridotID Smart-Account Whitepaper (contracts)

Scope: `contracts/evm` (Solidity) vs `contracts/svm/smart-account` (Pinocchio/Rust).
Status: **counterparts, not identical** — same passkey-owned model, different chain mechanics.
This document is the **single canonical spec**: V3 authorization + fee schema
(§2), both account implementations (§3–§7), the EVM permission layer (§10),
and the SVM session layer (§11), with verification and audit status (§9, §12).

## 1. Shared model

- Authority = secp256r1 (P-256) WebAuthn passkey. 1 PID = 1 account. Rotation never moves the address.
  On EVM V4 the owner passkey may additionally register scoped **session keys**
  (P-256, `sessions[permissionId]`) — same curve, separated by domain
  (`PID|EVM|PERMISSION|v1` + op tags `0x10..0x16`) and key slot, never by curve.
- Every sensitive op signs a domain-separated payload placed in the WebAuthn `challenge` (base64url, no padding). Program/contract recomputes it from its own args → blocks substitution.
- Signed message = `authenticatorData ‖ sha256(clientDataJSON)`.
- Replay guard = `nonce` (checked then incremented). EVM V4 adds per-permission
  `seq` (strict, then incremented) for session executions; owner grants/revokes/
  module ops consume the owner nonce. Expiry enforced on-chain with short TTLs (~5 minutes);
  permission grants additionally carry `validAfter/validUntil` (≤ 30 days,
  `MAX_PERMISSION_TTL`) plus a ≤600s execution deadline.
- Challenge parsing is duplicated per chain: find `"challenge":"…"`, base64url-decode, require 32 bytes.
- Sponsored-relayer model (canonical): Peridot sponsors transaction submission — the relayer pays network fees, the user authorizes the operation **plus a fee-policy version** with their passkey (never amounts). The backend attests the realtime `networkFee` at submit time; the contract/program recomputes `protocolFee` from the immutable policy table and enforces the split. The relayer is never an authority over user funds.
- Fee semantics (both chains): `relayerFee = networkFee` (exact reimbursement to the actual submitter/fee payer: EVM `msg.sender` — factory-caller passthrough on activation — / SVM relayer signer); `protocolFee = floor(networkFee × protocolFeeBps / 10_000)` to the canonical revenue recipient (EVM: the factory vault itself; SVM: build-time `TREASURY` vault). Policy v1 = 5000 bps (50%), `MAX = 5000`. `totalFee = networkFee + protocolFee` (additive: costs move with gas by design). No per-call treasury, no user-signed amounts.
- Cross-cluster validity (explicit trade-off, not an omission): the same PID derives to the same Solana PDA across devnet/testnet/mainnet, so no cluster ID / genesis hash enters the signed payload. An otherwise-valid SVM signature may be valid across clusters until its nonce is consumed or it expires — bounded by short expiries. EVM signatures stay chain-bound via `chainid`.

Core invariants (never weaken for convenience):

> The relayer may submit a transaction, but it must never be able to choose who
> owns the account, what the account does, where funds go, or which fee policy
> applies beyond what the user's passkey explicitly authorized.

> A permission is a scoped capability, never a second wallet. The EVM account
> stays the permanent asset-owning account; target allowlisting is UX/discovery
> only — every EVM guarantee holds against a fully adversarial,
> previously-unseen target contract.

> The SVM vault PDA that holds economic value never enters a game-targeting CPI —
> not as signer, not as writable, not at all. Gameplay CPIs are signed solely
> by a structurally separate session PDA holding rent-exempt minimum only.

Version freeze: V1 (`…SMART_ACCOUNT|v1`, exact-fee, unbound account/op) and V2
(`…|v2`, signed-`maxFee` cap model) payloads are frozen; no verifier accepts
another version's payloads.

| | SVM | EVM |
|---|---|---|
| Domain | `PID\|SOLANA\|SMART_ACCOUNT\|v3` (`auth.rs::DOMAIN_V3`, mirrors `packages/core/src/hash.ts::DOMAIN_V3`) | `PID\|EVM\|SMART_ACCOUNT\|v3` (`PeridotAccount.DOMAIN_V3`, mirrors `packages/core/src/evm.ts::DOMAIN_EVM_V3`) |
| Payload hash | `sha256(DOMAIN_V3‖opTag‖LE fields)` (`auth.rs::payload_hash_v3`) | `keccak256(DOMAIN_V3‖opTag‖chainid‖account‖…)` (`execute`/`updateAuthority`) |
| Authority encoding | 33B compressed key + 32B RP-ID hash in 112B PDA state v2 (`state.rs`) | `bytes32 x, y` + `bytes32 rpIdHash` storage (`PeridotAccount.sol`) |
| Sig verify | Secp256r1 precompile + Instructions-sysvar introspection (next ix), signer == stored, RP-ID hash + UV-flag `0x04` enforced (`auth.rs::verify_secp256r1_v2`) | Direct `P256.verify` (OZ, RIP-7212/fallback, low-S inside) + on-chain RP-ID hash + UV-flag `0x04` (`_verify`) |
| Address | PDA `["peridot_id","account",sha256(pid)]`, program `CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT` — deterministic per (seeds, program id); **one program keypair on every cluster → one address everywhere** | CREATE2 EIP-1167 proxy, `salt = bytes32(pidToSeed32(pid))`, same factory+impl → same address every chain |
| Clock | `Clock` sysvar, `i64 expiry` (TTL ≤ 600s enforced) | `block.timestamp`, `u64 deadline` (TTL ≤ 600s enforced) |
| Fee model | Attested networkFee + fixed protocol %: program recomputes `protocolFee`, splits relayerFee → relayer signer, protocolFee → canonical vault. EVM sanity-bounds attestation against measured gas (`GasAnomaly`); SVM relies on formula + `meta.fee` reconciliation | Same split: relayerFee → `msg.sender`, protocolFee → factory vault; same policy table/bound; same reconciliation |
| State | v2 PDA 112B (`v1 80B prefix + rpIdHash[32]`; v1 readable, V3 ops require v2) | Contract storage (`authorityX/Y`, `rpIdHash`, `nonce`, `initialized`, `factory`, V4 `_permissions`/`_modules`/`_locked`; `__gap` 44→38 slots) |

## 2. V3 authorization + fee schema (canonical)

All EVM/SVM/SDK/backend implementations MUST match this section byte-for-byte.
Exact per-operation payload layouts live with each implementation (§3 EVM
account ops, §6 SVM instructions); what follows are the shared rules.

Terminology (replaces `maxFee`/`base`/`markup`/`relayFee` — do not mix vocabularies):

- `networkFee`: realtime network cost attested by the backend at submit time
  (lamports / wei). On EVM the contract additionally sanity-bounds it against
  measured gas (see §9); on Solana it is purely attested (the program cannot
  observe the runtime-deducted fee — accepted, enforced by formula + reconciliation).
- `protocolFeeBps`: fixed protocol percentage in basis points, selected by the
  signed `feePolicyVersion` via an immutable on-chain table. Policy v1:
  **5000 bps (50%)**; `MAX_PROTOCOL_FEE_BPS = 5000`.
- `relayerFee = networkFee` (exact): reimbursement to the actual submitter/fee payer.
- `protocolFee = floor(networkFee × protocolFeeBps / 10_000)` (u128 intermediate
  on SVM, uint256 on EVM; floor favors the user — no dust loss).
- `totalFee = relayerFee + protocolFee` (additive: e.g. network 0.001 ETH at 50%
  → relayer 0.001, revenue 0.0005, user debited 0.0015; gas up/down moves both).

What the passkey signs: the full transaction intent (account, op-tag, nonce,
destination, value, calldata-hash, chain semantics, deadline/TTL) plus
**`feePolicyVersion` only — no amounts**. The percentage is protocol-fixed, so a
relayer cannot change what the user pays *in rate*; amounts float with gas by
design. There is deliberately no user-signed amount cap (locked decision):
over-attestation is bounded by `InsufficientFunds` (balance), the 120%-quote drift
rule below, TTL, and reconciliation alerts — trust-but-verify on the *number*,
cryptographic enforcement on the *rate*, recipients, and semantics.

Domains and operation tags:

| Chain | V3 domain (exact ASCII) |
|---|---|
| EVM | `PID\|EVM\|SMART_ACCOUNT\|v3` |
| SVM | `PID\|SOLANA\|SMART_ACCOUNT\|v3` |

Op-tags: `0x00` init, `0x01` spend, `0x02` token spend, `0x03` rotate,
`0x04` close, `0x05` activate, plus `0x06` SVM generic `execute` (disc 6;
EVM `execute` keeps its own `0x01`). V2 signatures can never verify as V3.

Settlement + EVM gas sanity (both chains, atomic single tx):

- EVM `execute`: `startGas = gasleft()` at entry; sanity `networkFee ≤ measured ×
  tx.gasprice × 2 + l1Allowance(chainid)` else revert (`GasAnomaly`; 2× headroom
  covers verification/payout overhead and testnet L2 data fees — a bound, not
  pricing). Then require `balance ≥ value + totalFee`; pay `relayerFee →
  msg.sender`, `protocolFee → address(factory)`; single transaction, no second
  distribution tx.
- EVM activation: same settlement with relayerFee → factory caller passthrough
  (`msg.sender` inside `initialize` is the factory itself); protocolFee →
  `address(factory)`.
- SVM: no measurement possible — enforce formula + `lamports ≥ amount +
  totalFee` (`≥ totalFee` token-only/execute, `≥ rent + totalFee` activation); base →
  relayer signer, protocolFee → canonical revenue vault (`config::TREASURY`,
  must equal the passed account).
- Errors: `UnknownFeePolicy`, `ExceedsMaxBps` (defensive), `GasAnomaly` (EVM),
  `InsufficientFunds`, `InvalidDestination` (non-canonical vault),
  `InvalidTarget` (SVM self-call), `Unauthorized` (SVM execute without PDA
  delegation). `FeeExceedsMax` is retired (no caps).

Factory revenue administration (EVM only): the factory **accumulates native
revenue directly** (`receive() payable`); `admins` (constructor-seeded, floor
≥1) manage `addAdmin`/`removeAdmin` (events `AdminAdded`/`AdminRemoved`) and
`withdrawRevenue` (event `RevenueWithdrawn`). Hard
prohibitions: no per-call treasury (the vault IS the factory); no function
touching user accounts, authorities, nonces, or fee policy; no
upgrade/selfdestruct/pause. Factory is never a wallet authority. (Full
mechanics in §4.)

Quote / drift / TTL / failure rules:

- Quote returns `{networkFee (realtime estimate), protocolFeeBps,
  feePolicyVersion, totalFee, chainTime}`. Backend recomputes attested
  `networkFee` at submit (EVM: live gas price × estimate + L1 data fee via
  chain oracle where available; SVM: `getFeeForMessage` on the exact message
  shape so quotes track `meta.fee` 1:1; no priority fees anywhere).
- Drift rule: reject submit when `attested × 100 > quoted × 120` (120.00%,
  integer basis-point ratio, fail-closed re-quote); no lower bound (drops benefit
  the user automatically).
- TTL: authorization ≤ 600s enforced server-side and on-chain; client signs with
  ~300s TTL. Cross-cluster validity (same PDA everywhere) remains accepted,
  bounded by TTL + nonce.
- Failures: policy/factor violations revert on-chain; stale nonce/expiry/TTL/
  drift/policy/balance fail pre-broadcast (400/409/503 taxonomy unchanged);
  fee spikes between attest and mining are absorbed by the relayer; overpay is
  impossible by formula (only over-attestation, caught by reconciliation).
- Reconciliation (all sponsored flows incl. both activations): verify
  `protocolFee == formula(networkFee)`, `attested ≈ actual` (EVM receipts +
  L2 fee data; SVM `meta.fee` + priority data) within tolerance; alert +
  security-event on divergence; log relayer P&L.

Determinism: EVM tuple = canonical PID normalization/hash + salt + factory +
implementation + clone initcode (chainId binds signatures only). SVM tuple =
canonical PID normalization/hash + seeds + program ID (BACKEND/TREASURY/vault/RPC
never enter derivation). State, nonce, balances, history stay chain-local. New
factory bytecode ⇒ new factory/account addresses (testnet reset; nothing on mainnet).

## 3. EVM — `src/PeridotAccount.sol` (V3 semantics + V4 permission layer)

V3 below is frozen. V4 (§10) keeps the
account the permanent asset-owning account and adds scoped capabilities:
owner-signed `grantPermission`/`revokePermission` (consume the owner nonce),
session-signed single-call `executeWithPermission` (strict per-permission `seq`,
exact scope match, spend caps), owner-gated `installModule`/`uninstallModule`
(validators/executors only), ERC-7579 `execute`/`executeFromExecutor` (single
`call` mode only — delegatecall/batch permanently rejected, no `DELEGATECALL`
opcode in the implementation), and owner-only ERC-1271 with account+chain
defensive rehash. A transient `_locked` mutex covers every untrusted-call path
(V3 `execute` included). Permission kinds: nonfinancial (exact target+selector,
financial-selector denylist), ETH / ERC-20 / ERC-721 / ERC-1155 (account-built
canonical calls, per-tx + lifetime caps). Session keys are P-256 like the
owner: OWNER vs PERMISSION separation is the `DOMAIN_PERM` + op-tag + key-slot
distinction, enforced on-chain and proven by the adversarial suite.

- `deployAndInit` is atomic **and passkey-authorized**: the user's P-256 key signs the canonical activation payload `keccak256(DOMAIN_V3 ‖ 0x05 ‖ salt ‖ x ‖ y ‖ rpIdHash ‖ feePolicyVersion ‖ deadline ‖ chainid ‖ factory)` — signed by the **new** key — binding the PID/salt, authority `(x, y)`, `rpIdHash`, fee-policy version, and deadline (plus `chainid` + factory). State is written only on a valid signature. A compromised relayer can neither squat an undeployed PID address, choose its authority, change the fee policy, nor redirect funds or revenue.
- Bare `deploy()` + ungated `initialize()` MUST NOT exist on production deployments. `initialize` is reachable only atomically through passkey-bound `deployAndInit` and additionally requires `msg.sender == factory`.
- `initialize(salt, x, y, rpIdHash, feePolicyVersion, deadline, networkFee, factory, payer, …assertion…)` — one-time setup. Reverts `AlreadyInitialized` / `ZeroAuthority` / `UnknownFeePolicy` / `ExceedsMaxBps` / `GasAnomaly`. Pre-funded counterfactual (first-top-up, SVM `activate` parity): attested `networkFee` sanity-checked against measured gas, split relayerFee → `payer` (the submitting relayer EOA; `msg.sender` here is the factory), protocolFee → factory vault. Emits `Initialized(x, y, networkFee, protocolFee)`. No constructor args so impl redeploys at one address (keyless CREATE2).
- `receive()` — accept plain ETH.
- `execute(to, value, data, deadline, feePolicyVersion, networkFee, …)` — mirrors SVM `withdraw_sol`: relayer submits/floats gas and attests `networkFee`; contract sanity-checks it (`GasAnomaly`), recomputes `protocolFee` from policy, requires `balance ≥ value + totalFee`; pays relayerFee → `msg.sender`, protocolFee → factory vault — atomically, in this same transaction (no second distribution tx). Canonical payload `keccak256(DOMAIN_V3 ‖ 0x01 ‖ chainid ‖ account ‖ nonce ‖ to ‖ value ‖ keccak256(data) ‖ deadline ‖ feePolicyVersion)`. Order: gas snapshot, `initialized`, `InvalidTarget`, `Expired`/TTL, policy gate, `_verify`, gas sanity, `InsufficientFunds`, `nonce++`, `to.call{value}(data)`, split payouts, `Executed(to, value, networkFee, protocolFee, n)`. `chainid`+`address(this)` bind replay to this chain+account.
- L2 actual cost: backend attests from live gas price × estimate plus L1 data fee via chain oracle where available (OP-Stack `GasPriceOracle`, best-effort); on-chain 2× measured-gas sanity bound absorbs testnet L2 data fees with headroom; receipt reconciliation verifies attested ≈ actual with alerts. Per-chain oracle pinning may tighten this later.
- `_executePayload(…)` — own frame for the canonical execute hash above (legacy codegen stack limit; `via_ir = true`).
- `updateAuthority(newX, newY, deadline, …)` — rotation, signed by **current** key. Zero-key + expiry/TTL checks, canonical payload `keccak256(DOMAIN_V3 ‖ 0x03 ‖ chainid ‖ account ‖ nonce ‖ newX ‖ newY ‖ deadline)`, writes keys, `nonce++`, emits `AuthorityUpdated`. No fee fields.
- `_verify(expected, authData, clientData, r, s)` — (1) `len ≥ 37`, `authData[0:32]==rpIdHash`, flag `authData[32]&0x04` (UV); (2) `h=sha256(authData‖sha256(clientData))`; (3) extracted challenge == expected else `InvalidChallenge`; (4) `P256.verify(h,r,s,x,y)` else `Unauthorized`.
- `_splitAttested` — `protocolFee = floor(networkFee × bps / 10_000)`, `relayerFee = networkFee` (exact; no dust loss).
- `_checkGasSanity` — `networkFee ≤ (startGas − gasleft()) × tx.gasprice × 2` else `GasAnomaly`.
- Errors: `AlreadyInitialized/NotInitialized/Unauthorized/InvalidChallenge/Expired/CallFailed/ZeroAuthority/InsufficientFunds/UnknownFeePolicy/ExceedsMaxBps/GasAnomaly/InvalidTarget`. No `FeeExceedsMax` (retired — no caps), no per-call treasury.
  V4 adds: `PermissionNotFound/AlreadyRevoked/PermissionExpired/BadSeq/ScopeMismatch/DeniedSelector/LimitExceeded/BadPermissionId/PermissionTTLExceeded/UnsupportedExecutionMode/UnsupportedModuleType/NotModule/AlreadyInstalled/Reentrancy`.
- `src/PeridotPermissionExecutor.sol` — ERC-7579 type-2 module, thin forwarder to
  `executeFromExecutor` (enforces nothing itself; all checks run in the account).

## 4. EVM — `src/Base64Url.sol`, `src/PeridotFactory.sol`

- `Base64Url.decode(input)` — minimal RFC-4648§5 no-padding decoder (`A-Z/a-z/0-9/-/_`), reverts `InvalidChar` (incl. `len%4==1`). Only what challenge parsing needs.
- `PeridotFactory.deployAndInit(salt, x, y, rpIdHash, feePolicyVersion, deadline, networkFee, …assertion…)` — **relayer-submitted but user-authorized**: requires `msg.sender == relayer` AND a valid passkey signature binding `(salt, x, y, rpIdHash, feePolicyVersion, deadline, chainid, factory)`; `updateRelayer` rotates (current relayer only; zero disables). `predict(salt)` stays open (view).
- Production MUST NOT expose bare `deploy(salt)`: removed. Tests must not depend on it.
- Revenue administration per §2 (factory IS the vault; admins floor ≥1; factory
  never touches accounts). No upgrade/selfdestruct/pause; deployer retains nothing.
- API never trusts code-presence: `poll()`/`viewOf()` promote to `active` only on exact `initialized + authorityX/Y + rpIdHash + factory` match; mismatches demote + warn (squat signal).
- `deployAndInit(…)` — clone + passkey-bound `initialize` atomically (no front-run window on authority, policy, or recipients). `InitFailed` on bad init; policy/gas failures revert before any state write. Factory passes its caller as the relayerFee recipient (its own `msg.sender` is unusable inside `initialize`).
- `predict(salt)` — counterfactual address (`Clones.predictDeterministicAddress`); must stay byte-identical to `deriveEvmSmartAccountAddress` (`@peridotvault/pid-evm`, forge parity test).
- Fee policy: fixed per-version `protocolFeeBps` (v1 = 5000) subject to on-chain `MAX_PROTOCOL_FEE_BPS = 5000`. No per-call amounts, no per-call treasury.

## 5. SVM — dispatch + state

- `lib.rs::process_instruction` — checks program id, splits discriminator byte → `Instruction::{Initialize=0, WithdrawSol=1, WithdrawToken=2, UpdateAuthority=3, Close=4, Activate=5, Execute=6, RegisterSession=7, SessionExecute=8, RevokeSession=9, CloseSession=10}` → handler. Owner authority is secp256r1 via precompile; session keys are Ed25519 (envelope signatures + on-chain record, §11).
- `state.rs::SmartAccount` (read) / `SmartAccountMut` (write) — v2 112B (`try_from_bytes` accepts v1 80B read-only; writers stamp v2), `authority()`, `account_id()`, `rp_id_hash()` (`MissingRpIdHash` on v1), `nonce()`, `initialize(id,key,rpId)`, `set_authority`, `increment_nonce`.
- `verify_pda(account, program, account_id)` — real `find_program_address` on-chain; host stub returns 255 (covered by integration suite, not units).
- `verify_nonce` — `state.nonce == ix.nonce` else `InvalidNonce`.
- `errors.rs::PeridotError`: `…/Forbidden` (`Forbidden` = non-backend creation attempt), `RetiredFeeExceedsMax = 12` (slot intentionally unused), `UnknownFeePolicy = 13`, `MissingRpIdHash = 14`, `ExceedsMaxBps = 15`, `InvalidTarget = 16` (execute self-call), session errors 17–22 (`SessionNotFound/Revoked/Expired`, `BadSessionSeq`, `SessionScopeViolation`, `SessionTtlExceeded`).
- `fee.rs`: `FEE_POLICY_V1 = 1`, `PROTOCOL_FEE_BPS_V1 = 5000`, `MAX_PROTOCOL_FEE_BPS = 5000`; `policy_protocol_bps()` (unknown → `UnknownFeePolicy`, over-max → `ExceedsMaxBps`); `split_attested_fee()` (relayerFee exact, protocol floor); `total_fee()` (saturating add).

## 6. SVM — instructions

- `initialize` (BACKEND payer SIGNER, PDA WRITE, system, sysvar): payer == `config::BACKEND` (`Forbidden` otherwise — PID-ownership proof), PDA empty check, `verify_pda`, passkey auth over canonical `sha256(DOMAIN_V3 ‖ 0x00 ‖ account_id ‖ authority[33] ‖ rpIdHash[32])`, `create_account…_signed` (112B), write v2 state, log `AccountInitialized`. Only the new authority's key + the backend together can claim — no squat.
- `withdraw_sol` (PDA, dest, revenue vault, relayer SIGNER, instructions sysvar; recipients canonical): relayer signer (any submitter — payload fully bound), owner/init/dest≠self checks, dest addr == arg check, nonce+PDA verify, canonical payload `sha256(DOMAIN_V3 ‖ 0x01 ‖ account_id ‖ nonce ‖ amount ‖ dest[32] ‖ expiry ‖ feePolicyVersion)` (no amounts — costs float), `check_expiry` (TTL ≤ 600), `verify_secp256r1_v2` (signer + RP-ID + UV + challenge), recompute split, `lamports ≥ amount+totalFee`, moves (relayerFee→relayer, protocolFee→vault; no System CPI), `increment_nonce`, log `TransactionExecuted`.
- `withdraw_token` (+source ATA, mint, dest ATA, token program): as `withdraw_sol` plus `sourceAta[32]` in the payload; program asserts source ATA owned by PDA for mint; SPL `Transfer` CPI signed by PDA seeds for `amount`; SOL split `lamports ≥ totalFee` only (token balance enforced by token program).
- `update_authority` (PDA, sysvar): canonical payload `sha256(DOMAIN_V3 ‖ 0x03 ‖ account_id ‖ nonce ‖ new_key[33] ‖ expiry)`, verified by **current** key, zero-key rejected, then `set_authority` + `increment_nonce`, log `AuthorityUpdated`. No fee fields.
- `close` (PDA, dest, sysvar): canonical payload `sha256(DOMAIN_V3 ‖ 0x04 ‖ account_id ‖ nonce ‖ dest[32] ‖ expiry)`; `dest != PDA` required; drains all lamports to dest, `account.close()`, log `AccountClosed`. Teardown only — no V1 API.
- `activate` (BACKEND relayer SIGNER, PDA, vault, system, sysvar): sponsored claim, **relayer == BACKEND** (`Forbidden` otherwise) + passkey auth over canonical `sha256(DOMAIN_V3 ‖ 0x05 ‖ account_id ‖ authority[33] ‖ rpIdHash[32] ‖ feePolicyVersion ‖ expiry)`. Rejects already-program-owned/non-empty; `create_account…_signed` creates (empty) or tops-up→assigns (pre-funded deposit); requires `lamports ≥ rent + totalFee`; splits relayerFee→relayer, protocolFee→vault; writes v2 state; log `AccountActivated`.
- `execute` (disc 6; PDA, relayer SIGNER, vault, target program, sysvar, + non-PDA metas): generic CPI, wallet parity with EVM `execute`. Deny-list of one (target ≠ program, `InvalidTarget`); passkey signs canonical `sha256(DOMAIN_V3 ‖ 0x06 ‖ account_id ‖ nonce ‖ expiry ‖ feePolicyVersion ‖ call_hash)` where `call_hash = sha256` over the exact target‖metas‖data bytes; instruction data `nonce ‖ target[32] ‖ meta_count u8 ‖ metas meta_count×(addr[32] ‖ flags u8: bit0 writable, bit1 signer) ‖ data_len u16 ‖ data ‖ expiry ‖ policy ‖ network_fee ‖ len ‖ clientDataJSON` (caps: 64 metas, 10_240B data; the tx size limit binds first). The program additionally requires the PDA among the metas with the signer bit (bound PDA metas map to account 0 — outer transactions deduplicate it), enforces address match per meta at CPI time, and settles the standard fee split (`lamports ≥ totalFee`; the call itself moves no SOL — inner programs debit their own accounts). Token-2022 needs no special case (target is opaque bytes).
- Sessions (discs 7–10; §11, canonical): the vault PDA above never enters game CPIs. `register_session` (owner P-256, consumes owner nonce) binds an Ed25519 session key + one allowlisted game (+ verified upgrade snapshot) into a fresh 205B session PDA (`["peridot_id","session",account_id,session_key]`, program-created for exact rent); `session_execute` (session envelope signer + strict per-session `seq`, 24h hard expiry + 30min inactivity on the chain clock) runs one game CPI signed solely by the session PDA, with exact account count (no `remaining_accounts`), bounded protected accounts hash-pinned pre/post (owner/lamports/data, incl. delegate/close_authority), and per-execution upgrade-visibility refresh (record-and-log, no enforcement); `revoke_session` (owner P-256, immediate) and `close_session` (revoked-or-expired, rent reclaimed) consume the owner nonce. Gameplay pays its own fees (no relayer split).
- Attested-fee model (explicit): the program enforces the rate, recipients, and formula over the backend-attested `networkFee` but MUST NOT pretend to determine the complete transaction fee from inside the program — the runtime deducts base fee + prioritization fees + rent from the fee payer, none of which is reliably introspectable on-chain. Attestation is quoted live, drift-bounded (≤120% of quote, fail-closed re-quote), TTL-bounded; reconciliation verifies attested ≈ actual (`meta.fee` + priority data) with alerts. The relayer absorbs spike underpayment between attest and mining.

## 7. SVM — auth plumbing

- `auth.rs::payload_hash_v3(parts)` — `sha256(DOMAIN_V3‖parts…)` into 256B stack buf; every part fixed-size LE/raw so SDK recomputes exactly. (V1/V2 hashes frozen.)
- `verify_secp256r1_v2(ix_sysvar, expected_key, expected_rp_id, clientData, payload)` — (1) next ix is secp precompile, recovered key == stored; (2) signed msg is exactly `authData‖sha256(clientData)` (≥69B); (3) `authData[0:32]==rpIdHash`, flag `0x04` set; (4) decoded challenge == payload.
- `check_expiry` — `Clock::unix_timestamp > expiry → Expired`; `expiry − now > 600 → Expired` (TTL cap bounds cross-cluster replay).
- `extract_challenge` / `base64url_decode` / `find_subslice` — same algorithm as EVM `_extractChallenge`/`_find`/`Base64Url.decode`.
- `secp256r1.rs` — vendored precompile deserializer (`num_signatures`, offsets, `get_signer/signature/message_data`); local-data only (`instruction_index == u16::MAX`).
- `sha256.rs` — pure-Rust FIPS-180-4 (`sol_sha256` crashes this SBF toolchain); tested vs `""`/`"abc"`/multiblock vectors.

## 8. Parity matrix (is `execute` == withdraw? Yes, economically)

| Function | Same? | Note |
|---|---|---|
| init (`initialize` both) | Roughly | Both one-time + zero-key guard + co-signed claim (SVM: BACKEND + passkey; EVM: relayer-submitted + passkey-bound `deployAndInit`); SVM creates PDA via CPI, EVM called by factory proxy |
| spend (`execute` vs `withdraw_sol/withdraw_token`) | **Yes (economics)** | Attested `networkFee` + fixed policy % (≤ on-chain maximum); relayerFee→fee payer, protocolFee→revenue vault; EVM adds gas sanity bound; both chains now have a generic `execute` (SVM disc 6 signs `call_hash`, EVM signs `to‖value‖keccak(data)`), SVM keeps typed withdraw handlers for the common paths |
| `updateAuthority` both | **Yes, closest match** | Same nonce/expiry/challenge flow, signed by current key; no fee fields |
| challenge/base64/find | **Yes (logic)** | Duplicated implementations, same algorithm |
| sig verify | **Yes (semantics)** | Precompile-introspection vs `P256.verify`, both with RP-ID/UV |
| `activate` fee vs `deployAndInit` fee | **Yes** | Both attest `networkFee` + fixed policy %; relayerFee→submitter (factory-caller passthrough on EVM), protocolFee→vault |
| `close` | SVM-only | Teardown, no V1 API; no EVM equivalent |
| factory revenue/admin | EVM-only | No SVM equivalent (build-time vault const); factory accumulates + admin-gated withdrawals, never touches accounts |
| sessions (EVM perms vs SVM sessions) | **No (different boundaries)** | Same goal, separate designs, never shared keys/nonces: EVM = one account + exact-call construction (§10); SVM = two-PDA isolation + upgrade-pinned allowlist (§11) |

## 9. Notes / verification

- Low-S enforced both sides (SVM precompile, EVM OZ lib); SVM needs `skipPreflight` (no simulate), EVM high-S test asserts revert.
- `sol_sha256` crash → pure-Rust SHA-256; expiries use chain clocks, not device time. Signature TTLs stay short (600s max, ~300s client) — the primary bound on cross-cluster validity (see §1).
- Sponsored model is canonical: Peridot sponsors submission, the user authorizes the operation plus a fixed fee policy with a passkey, the backend attests realtime network cost, contracts enforce rate/recipients/formula, revenue lands in the factory vault (EVM) / build-time vault (SVM). No revert to amount-capped or client-pays models.
- Reconciliation (both chains, all sponsored flows): backend verifies `protocolFee == formula(networkFee)` and `attested ≈ actual` from confirmed transaction metadata (EVM receipts + L2 oracle data; Solana `meta.fee` + priority-fee data), with alerts on divergence. Spike underpayment between attest and mining is absorbed by the relayer.
- Verify: `cd contracts/evm && forge test` (65: V3 passkey-bound `deployAndInit`,
  squat-attempt, policy/sanity/admin/revenue cases + 33 V4 permission/adversarial
  cases: unauthorized finance, escalation, reentry, 1271 misuse, replay, revocation,
  delegatecall-absence) + `node test/anvil-v3-e2e.mjs` (TS→contract loop) +
  `node test/anvil-v4-perm-e2e.mjs` (SDK grant→session-exec→revoke loop) ·
  `cd contracts/svm/smart-account && PID_BACKEND=<key> PID_TREASURY=<key> cargo build-sbf && cargo test` (27) + `node tests/integration.mjs <id>` (37: squat/Forbidden/policy/attested-fee/rounding/execute cases) + `node tests/session.mjs <id> <forwarder-id>` (24 session cases: isolation, forwarding bounds, protected invariants, replay, lifecycle) + `node ../../packages/solana/test/adapter.e2e.mjs` · `pnpm typecheck` · `pnpm --filter @peridotvault/pid-api exec jest` (259).
- Security model: creation = passkey-authorized (+ backend-gated on SVM `initialize`/`activate`; relayer-submission-gated + passkey-bound on EVM `deployAndInit`); spends = passkey-signed intents with fully-bound semantics (account, op, nonce, dest, value, calldata, chain, deadline, policy); EVM V4 adds owner-authorized permission grants plus session-signed executions inside owner-set scope (permission id, seq, target/data, caps, expiry, revocation); SVM sessions add owner-registered Ed25519 gameplay sessions inside PDA-isolated scope (session seq, allowlisted game, protected invariants, 24h/inactivity bounds, revocation); submission is permissionless by design. A compromised relayer may waste its own gas or submit valid user-signed intents (bounded by balance/TTL/drift/reconciliation) but MUST NOT forge authority, alter bound fields, change the fee policy, redirect funds or revenue, or settle anything but `networkFee + formula(networkFee)`.

## 10. EVM permission layer (canonical)

V4 adds scoped capabilities to `PeridotAccount` without changing any V3 payload,
signature, or fee rule. Roles: **OWNER** = the P-256 passkey (V3 paths
unchanged); **PERMISSION key** = a P-256 session key per permission — same curve
by product choice, so separation rests **entirely** on domain separation
(load-bearing): owner payloads use `DOMAIN_V3` + `0x01/0x03/0x05` or the
`DOMAIN_PERM` owner ops below; permission payloads use
`DOMAIN_PERM = "PID|EVM|PERMISSION|v1"` + ops `0x10..0x16`. Key-slot check:
owner fns verify against `authorityX/Y`, permission exec against the stored
`session` key; cross-use reverts `Unauthorized`.

Payloads (`keccak256`, `abi.encodePacked` order). Common: `chainid uint256`,
`account address`, `nonce/seq uint64`, `deadline uint64` (TTL ≤ 600s,
`MAX_TTL`), `feePolicyVersion uint16` (rate only):

- `permissionId = keccak256(DOMAIN_PERM ‖ chainid ‖ account ‖ sessionX ‖
  sessionY ‖ kind:u8 ‖ target ‖ selector:b4 ‖ token ‖ to ‖ nftId:u256 ‖
  validUntil:u64 ‖ salt)` — owner-salt re-grant uniqueness.
- `grant = keccak256(DOMAIN_PERM ‖ 0x10 ‖ chainid ‖ account ‖ permissionId ‖
  sessionX ‖ sessionY ‖ kind ‖ target ‖ selector ‖ token ‖ to ‖ perTxCap:u256 ‖
  totalLimit:u256 ‖ nftId ‖ validAfter:u64 ‖ validUntil:u64 ‖ nonce ‖ deadline)`
  — owner-signed, consumes the owner nonce.
- `revoke = keccak256(DOMAIN_PERM ‖ 0x11 ‖ chainid ‖ account ‖ permissionId ‖
  nonce ‖ deadline)` — owner-signed, immediate state flip.
- `permExec = keccak256(DOMAIN_PERM ‖ 0x12 ‖ chainid ‖ account ‖ permissionId ‖
  seq ‖ target ‖ value:u256 ‖ keccak256(data) ‖ deadline ‖ feePolicyVersion)`
  — session-signed; strict `seq`, then `seq++`.
- `install/uninstall = keccak256(DOMAIN_PERM ‖ 0x13/0x14 ‖ chainid ‖ account ‖
  moduleType:u256 ‖ module ‖ keccak256(initData) ‖ nonce ‖ deadline)`.
- `exec7579 = keccak256(DOMAIN_PERM ‖ 0x15 ‖ chainid ‖ account ‖ nonce ‖ target ‖
  value ‖ keccak256(data) ‖ deadline ‖ feePolicyVersion)`.
- `1271 challenge = keccak256(DOMAIN_V3 ‖ 0x16 ‖ chainid ‖ account ‖ hash)` —
  defensive rehash (account + chain bound; cf. ERC-7739/Coinbase replaySafeHash).

Replay: owner nonce (grants/revokes/installs), per-permission `seq`, chainid +
account everywhere, short deadlines, `validUntil ≤ now + 30d`
(`MAX_PERMISSION_TTL`). Revocation is state-based, needs no session cooperation.

Scope kinds (single call per execution — no batch in v1):

1. **NONFINANCIAL** `{target, selector}`: exactly one call shape, `value == 0`,
   exact target match (never account/factory/zero), exact selector match, and
   never a denylisted selector. Unknown/unaudited targets are safe by §5-style
   enforcement below, not by auditing.
2. **ETH** `{to, perTxCap, totalLimit}`: account-built value transfer only
   (`data` empty, `target == to`, `0 < value ≤ perTxCap`, `spent + value ≤ totalLimit`).
3. **ERC-20** `{token, to, perTxCap, totalLimit}`: `data` exactly
   `transfer(to, amount)` on `token` with caps as above.
4. **ERC-721** `{token, to, nftId}`: `transferFrom` / 3-arg `safeTransferFrom`
   with `from == account`, exact `to`/`id`, one-shot (`spent` 0→1).
5. **ERC-1155** `{token, to, nftId, perTxCap, totalLimit}`:
   `safeTransferFrom(account, to, id, amount, "")`, empty data only.

Spend accounting updates **before** the untrusted call; fee settlement equals V3.

ERC-7579 surface (full interface, constrained modes): `accountId`
(`"peridot.pid-account.v4"`), `supportsModule` (validator=1/executor=2 only),
`supportsExecutionMode` (only `MODE_SINGLE_DEFAULT = bytes32(0)`),
`isModuleInstalled`, owner-signed `installModule`/`uninstallModule` (effects
first, `onInstall`/`onUninstall` last), `execute(bytes32,bytes)` (owner auth
inside `executionCalldata`), `executeFromExecutor` (`onlyExecutorModule`; all
checks run in the account), `isValidSignatureWithSender`.
`PeridotPermissionExecutor` is a thin type-2 forwarder; `ENTRY_POINT` reserved
zero. Permanently unsupported: **delegatecall/batch modes, fallback/hook
modules** — no `DELEGATECALL` opcode in the implementation (CI-enforced).

Adversarial guarantees (all against fully adversarial targets): direct theft
blocked by §-scope + canonical construction; approval creation blocked by the
grant+execution denylist (second layer — exact match/canonical shape is first);
self-call reverts; reentrant escalation blocked by the `_locked` mutex;
`delegatecall` absent in bytecode; ERC-1271 owner-only (session material never
verifies, cross-account replay fails); replay/extension/post-revoke use
blocked per above; relayer abuse bounded exactly as V3.

## 11. SVM session layer (canonical)

Counterpart of the permission goal under a structurally different boundary —
not a port; no shared code, keys, nonces, or trust assumptions with §10.
Roles: **OWNER** = the P-256 passkey (unchanged); **SESSION key** = an Ed25519
keypair per session (envelope signatures are Ed25519-only; the precompile is
instruction-data-only, 0-CU, one 5,000-lamport fee per use — so P-256
authorizes registration once, never per gameplay action).

Accounts: vault PDA `["peridot_id","account",sha256(pid)]` (existing, 112B);
session PDA `["peridot_id","session",account_id,session_pubkey]`, program-owned,
fixed 205B record (`version u8 ‖ status u8 ‖ session_pubkey[32] ‖ account_id[32] ‖
expires_at i64LE ‖ last_used i64LE ‖ seq u64LE ‖ allowed_program[32] ‖
recorded_authority[32] ‖ recorded_has_authority u8 ‖ recorded_slot u64LE ‖
last_seen_authority[32] ‖ last_seen_has_authority u8 ‖ last_seen_slot u64LE ‖
bump u8`). One session pubkey ⇒ one PDA.
Rent-exempt minimum exactly, program-created (PDAs cannot sign client-side
creates), owner-reclaimed.

Instructions (domain `PID|SOLANA|SESSION|v1`):

- `register_session` (7), owner P-256: binds session key + one allowlisted game
  + verified upgrade snapshot + `expires_at ≤ now+24h`; consumes the owner
  nonce. Accounts: vault `[WRITE]`, session PDA `[WRITE]` (must not exist),
  instructions sysvar, upgrade evidence, game program, payer `[SIGNER]`,
  system program.
- `session_execute` (8), session Ed25519 (`is_signer` + key match): strict
  `seq`, hard expiry (24h) + inactivity (30min) on the chain `Clock`,
  allowlist match, self-call block, vault-absence enforcement (derived
  on-chain), ≥1 session-signer meta naming the session PDA, exact account
  count (**`remaining_accounts` rejected**), protected-account pre/post
  invariant checks, upgrade-visibility refresh. No fee split: the session
  holder pays their own transaction fee.
- `revoke_session` (9), owner P-256: immediate `revoked` flip, owner nonce.
- `close_session` (10), owner P-256: revoked-or-expired only, rent to an
  owner-bound destination, owner nonce.

Payloads (`sha256`, LE): register `SESSION‖0x07‖account‖nonce‖session_key‖
program‖expires_at‖rec_has_auth‖rec_auth‖rec_slot‖expiry`; revoke
`SESSION‖0x09‖account‖session_key‖nonce‖expiry`; close `SESSION‖0x0A‖account‖
session_key‖destination‖nonce‖expiry`. Execution is Ed25519-authorized
(no P-256 payload) with strict per-session `seq`.

Upgrade visibility (record-and-log, owner-accepted risk): loader classes read
from the game program's owner — upgradeable-loader programs carry a
`ProgramData { slot, upgrade_authority }` (derived, loader-ownership-checked,
parsed: 45-byte metadata, variant u32 + slot u64 + one-byte COption tag,
verified against chain truth) matched to the owner-signed snapshot at
registration, with per-execution `last_seen_*` refresh for indexers;
native/deprecated-loader programs are immutable (no ProgramData; evidence is
the program itself); unknown loaders fail closed. No enforcement on
post-registration change by owner choice.

Adversarial guarantees (all against live validator): vault drain impossible
(vault derived on-chain, rejected in metas and accounts); forwarded signer
moves session-owned tokens only (vault absent/unsigned); session SOL
structurally immobile (system debits only data-less accounts); protected
delegate/close_authority edits caught with balances unchanged; vault token
movement fails (no vault signature); replay/stale-seq, expired/inactive/
revoked use rejected; substitution via extra accounts rejected; lied upgrade
snapshots rejected at registration; close reclaims only dead sessions to
owner-bound destinations.

## 12. Proven vs architectural claim (pre-audit)

Proven — EVM (65 forge tests incl. 33 permission/adversarial, anvil V3+V4 E2E,
byte-exact SDK vectors, 9 backend specs): §10 table for single-call scope,
OWNER/PERMISSION disjointness, revocation immediacy, fee parity, no-delegatecall
bytecode, SDK↔contract interop. Proven — SVM (27 host unit, 24 validator
session cases incl. malicious-forwarder forwarding bounds, 37 existing
integration cases, SDK/backend specs): §11 table for single-CPI scope, domain
disjointness, revocation immediacy, rent-exact lifecycle, loader classes,
SDK↔program byte parity via independent reimplementation.

Architectural claim (external human audit required before immutability or
mainnet, for either chain): 7579 module composition beyond the shipped
executor; Token-2022 extensions beyond base authority fields; hostile-CPI
griefing bounds; upgrade-visibility sufficiency under the no-enforcement
policy; inactivity-window adequacy; indexer coverage of `last_seen_*` drift;
P-256 session gas-griefing bounds; 4337 mempool behavior. **Do not deploy to
mainnet or burn/fire upgrade authority on the basis of this work alone.**

Unactioned pre-mainnet runbook (carried from the deleted tasks file, still open):

- [ ] External program audit (internal baselines: 65 forge + 27 cargo + 37/24 validator cases).
- [ ] Upgrade authority custody — stakeholder hardware/multisig key + recorded holder/rotation.
- [ ] Mainnet deploy (new keypair, production RPCs, OAuth app, prod DB).
- [ ] Dependency audits (`pnpm audit` + `cargo audit`).
- [ ] Fee-payer secure storage (WebCrypto default in SDK).
- [ ] Observability/alerting (revocation spikes, intent rejections, `last_seen_*` drift).
- [ ] Backup/restore + incident response runbooks; CI secret-pattern grep.
