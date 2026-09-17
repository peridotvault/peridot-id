# PeridotID Smart-Account Whitepaper (contracts)

Scope: `contracts/evm` (Solidity) vs `contracts/svm/smart-account` (Pinocchio/Rust).
Status: **counterparts, not identical** — same passkey-owned model, different chain mechanics.
Canonical fee/authorization schema: V3 (`contracts/V2_AUTHORIZATION.md`); EVM V4
permission layer (`contracts/V4_PERMISSIONS.md`, canonical) adds scoped P-256
session keys + ERC-7579 + ERC-1271 without changing any V3 payload or rule.

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

## 2. EVM — `src/PeridotAccount.sol` (V3 semantics + V4 permission layer)

V3 below is frozen. V4 (`contracts/V4_PERMISSIONS.md`, canonical) keeps the
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

- `deployAndInit` is atomic **and passkey-authorized**: the user's P-256 key signs an activation payload binding the PID/salt, authority `(x, y)`, `rpIdHash`, fee-policy version, and deadline (plus `chainid` + factory). State is written only on a valid signature. A compromised relayer can neither squat an undeployed PID address, choose its authority, change the fee policy, nor redirect funds or revenue.
- Bare `deploy()` + ungated `initialize()` MUST NOT exist on production deployments. `initialize` is reachable only atomically through passkey-bound `deployAndInit` and additionally requires `msg.sender == factory`.
- `initialize(salt, x, y, rpIdHash, feePolicyVersion, deadline, networkFee, factory, payer, …assertion…)` — one-time setup. Reverts `AlreadyInitialized` / `ZeroAuthority` / `UnknownFeePolicy` / `ExceedsMaxBps` / `GasAnomaly`. Pre-funded counterfactual (first-top-up, SVM `activate` parity): attested `networkFee` sanity-checked against measured gas, split relayerFee → `payer` (the submitting relayer EOA; `msg.sender` here is the factory), protocolFee → factory vault. Emits `Initialized(x, y, networkFee, protocolFee)`. No constructor args so impl redeploys at one address (keyless CREATE2).
- `receive()` — accept plain ETH.
- `execute(to, value, data, deadline, feePolicyVersion, networkFee, …)` — mirrors SVM `withdraw_sol`: relayer submits/floats gas and attests `networkFee`; contract sanity-checks it (`GasAnomaly`), recomputes `protocolFee` from policy, requires `balance ≥ value + totalFee`; pays relayerFee → `msg.sender`, protocolFee → factory vault — atomically, in this same transaction (no second distribution tx). Order: gas snapshot, `initialized`, `InvalidTarget`, `Expired`/TTL, policy gate, `_verify`, gas sanity, `InsufficientFunds`, `nonce++`, `to.call{value}(data)`, split payouts, `Executed(to, value, networkFee, protocolFee, n)`. `chainid`+`address(this)` bind replay to this chain+account.
- L2 actual cost: backend attests from live gas price × estimate plus L1 data fee via chain oracle where available (OP-Stack `GasPriceOracle`, best-effort); on-chain 2× measured-gas sanity bound absorbs testnet L2 data fees with headroom; receipt reconciliation verifies attested ≈ actual with alerts. Per-chain oracle pinning may tighten this later.
- `_executePayload(…)` — own frame for the `keccak256(DOMAIN_V3‖0x01‖chainid‖this‖nonce‖to‖value‖keccak256(data)‖deadline‖feePolicyVersion)` hash (legacy codegen stack limit; `via_ir = true`).
- `updateAuthority(newX, newY, deadline, …)` — rotation, signed by **current** key. Zero-key + expiry/TTL checks, payload `keccak256(DOMAIN_V3‖0x03‖chainid‖this‖nonce‖newX‖newY‖deadline)`, writes keys, `nonce++`, emits `AuthorityUpdated`. No fee fields.
- `_verify(expected, authData, clientData, r, s)` — (1) `len ≥ 37`, `authData[0:32]==rpIdHash`, flag `authData[32]&0x04` (UV); (2) `h=sha256(authData‖sha256(clientData))`; (3) extracted challenge == expected else `InvalidChallenge`; (4) `P256.verify(h,r,s,x,y)` else `Unauthorized`.
- `_splitAttested` — `protocolFee = floor(networkFee × bps / 10_000)`, `relayerFee = networkFee` (exact; no dust loss).
- `_checkGasSanity` — `networkFee ≤ (startGas − gasleft()) × tx.gasprice × 2` else `GasAnomaly`.
- Errors: `AlreadyInitialized/NotInitialized/Unauthorized/InvalidChallenge/Expired/CallFailed/ZeroAuthority/InsufficientFunds/UnknownFeePolicy/ExceedsMaxBps/GasAnomaly/InvalidTarget`. No `FeeExceedsMax` (retired — no caps), no per-call treasury.
  V4 adds: `PermissionNotFound/AlreadyRevoked/PermissionExpired/BadSeq/ScopeMismatch/DeniedSelector/LimitExceeded/BadPermissionId/PermissionTTLExceeded/UnsupportedExecutionMode/UnsupportedModuleType/NotModule/AlreadyInstalled/Reentrancy`.
- `src/PeridotPermissionExecutor.sol` — ERC-7579 type-2 module, thin forwarder to
  `executeFromExecutor` (enforces nothing itself; all checks run in the account).

## 3. EVM — `src/Base64Url.sol`, `src/PeridotFactory.sol`

- `Base64Url.decode(input)` — minimal RFC-4648§5 no-padding decoder (`A-Z/a-z/0-9/-/_`), reverts `InvalidChar` (incl. `len%4==1`). Only what challenge parsing needs.
- `PeridotFactory.deployAndInit(salt, x, y, rpIdHash, feePolicyVersion, deadline, networkFee, …assertion…)` — **relayer-submitted but user-authorized**: requires `msg.sender == relayer` AND a valid passkey signature binding `(salt, x, y, rpIdHash, feePolicyVersion, deadline, chainid, factory)`; `updateRelayer` rotates (current relayer only; zero disables). `predict(salt)` stays open (view).
- Production MUST NOT expose bare `deploy(salt)`: removed. Tests must not depend on it.
- Factory is the canonical revenue vault: `receive() payable` accumulates protocol fees; `admins` (constructor-seeded, mapping + count) manage `addAdmin` / `removeAdmin` (admin-only, floor ≥1 — removing the last reverts `LastAdmin`) and `withdrawRevenue(destination, amount)` (admin-only, `amount ≤ balance`, events). Hard prohibitions: no per-call treasury (the vault IS the factory), no function touching user accounts/authorities/nonces/policy, no upgrade/selfdestruct/pause. Factory is never a wallet authority; deployer retains nothing.
- API never trusts code-presence: `poll()`/`viewOf()` promote to `active` only on exact `initialized + authorityX/Y + rpIdHash + factory` match; mismatches demote + warn (squat signal).
- `deployAndInit(…)` — clone + passkey-bound `initialize` atomically (no front-run window on authority, policy, or recipients). `InitFailed` on bad init; policy/gas failures revert before any state write. Factory passes its caller as the relayerFee recipient (its own `msg.sender` is unusable inside `initialize`).
- `predict(salt)` — counterfactual address (`Clones.predictDeterministicAddress`); must stay byte-identical to `deriveEvmSmartAccountAddress` (`@peridotvault/pid-evm`, forge parity test).
- Fee policy: fixed per-version `protocolFeeBps` (v1 = 5000) subject to on-chain `MAX_PROTOCOL_FEE_BPS = 5000`. No per-call amounts, no per-call treasury.

## 4. SVM — dispatch + state

- `lib.rs::process_instruction` — checks program id, splits discriminator byte → `Instruction::{Initialize=0, WithdrawSol=1, WithdrawToken=2, UpdateAuthority=3, Close=4, Activate=5, Execute=6, RegisterSession=7, SessionExecute=8, RevokeSession=9, CloseSession=10}` → handler. Owner authority is secp256r1 via precompile; session keys are Ed25519 (envelope signatures + on-chain record, ADR-010).
- `state.rs::SmartAccount` (read) / `SmartAccountMut` (write) — v2 112B (`try_from_bytes` accepts v1 80B read-only; writers stamp v2), `authority()`, `account_id()`, `rp_id_hash()` (`MissingRpIdHash` on v1), `nonce()`, `initialize(id,key,rpId)`, `set_authority`, `increment_nonce`.
- `verify_pda(account, program, account_id)` — real `find_program_address` on-chain; host stub returns 255 (covered by integration suite, not units).
- `verify_nonce` — `state.nonce == ix.nonce` else `InvalidNonce`.
- `errors.rs::PeridotError`: `…/Forbidden` (`Forbidden` = non-backend creation attempt), `RetiredFeeExceedsMax = 12` (slot intentionally unused), `UnknownFeePolicy = 13`, `MissingRpIdHash = 14`, `ExceedsMaxBps = 15`, `InvalidTarget = 16` (execute self-call), session errors 17–22 (`SessionNotFound/Revoked/Expired`, `BadSessionSeq`, `SessionScopeViolation`, `SessionTtlExceeded`).
- `fee.rs`: `FEE_POLICY_V1 = 1`, `PROTOCOL_FEE_BPS_V1 = 5000`, `MAX_PROTOCOL_FEE_BPS = 5000`; `policy_protocol_bps()` (unknown → `UnknownFeePolicy`, over-max → `ExceedsMaxBps`); `split_attested_fee()` (relayerFee exact, protocol floor); `total_fee()` (saturating add).

## 5. SVM — instructions

- `initialize` (BACKEND payer SIGNER, PDA WRITE, system, sysvar): payer == `config::BACKEND` (`Forbidden` otherwise — PID-ownership proof), PDA empty check, `verify_pda`, passkey auth over `sha256(DOMAIN_V3‖0x00‖account_id‖authority‖rpIdHash)`, `create_account…_signed` (112B), write v2 state, log `AccountInitialized`. Only the new authority's key + the backend together can claim — no squat.
- `withdraw_sol` (PDA, dest, revenue vault, relayer SIGNER, instructions sysvar; recipients canonical): relayer signer (any submitter — payload fully bound), owner/init/dest≠self checks, dest addr == arg check, nonce+PDA verify, payload `sha256(DOMAIN_V3‖0x01‖account_id‖nonce‖amount‖dest‖expiry‖policy)` (no amounts — costs float), `check_expiry` (TTL ≤ 600), `verify_secp256r1_v2` (signer + RP-ID + UV + challenge), recompute split, `lamports ≥ amount+totalFee`, moves (relayerFee→relayer, protocolFee→vault; no System CPI), `increment_nonce`, log `TransactionExecuted`.
- `withdraw_token` (+source ATA, mint, dest ATA, token program): same V3 auth with `dest_ata` **+ source ATA** in payload + explicit ATA ownership/mint checks; SPL `Transfer` CPI signed by PDA seeds for `amount`; SOL split `lamports ≥ totalFee` only (token balance enforced by token program).
- `update_authority` (PDA, sysvar): payload `sha256(DOMAIN_V3‖0x03‖account_id‖nonce‖new_key[33]‖expiry)`, verified by **current** key, zero-key rejected, then `set_authority` + `increment_nonce`, log `AuthorityUpdated`. No fee fields.
- `close` (PDA, dest, sysvar): payload binds `dest` (`0x04‖account_id‖nonce‖dest‖expiry`); `dest != PDA` required; drains all lamports to dest, `account.close()`, log `AccountClosed`. Teardown only — no V1 API (ADR-004).
- `activate` (BACKEND relayer SIGNER, PDA, vault, system, sysvar): sponsored claim, **relayer == BACKEND** (`Forbidden` otherwise) + passkey auth over `sha256(DOMAIN_V3‖0x05‖account_id‖authority‖rpIdHash‖policy‖expiry)`. Rejects already-program-owned/non-empty; `create_account…_signed` creates (empty) or tops-up→assigns (pre-funded deposit); requires `lamports ≥ rent + totalFee`; splits relayerFee→relayer, protocolFee→vault; writes v2 state; log `AccountActivated`.
- `execute` (disc 6; PDA, relayer SIGNER, vault, target program, sysvar, + non-PDA metas): generic CPI, wallet parity with EVM `execute`. Deny-list of one (target ≠ program, `InvalidTarget`); passkey signs `call_hash` over the exact target‖metas‖data bytes (`0x06‖account_id‖nonce‖expiry‖policy‖call_hash`); PDA must appear in metas with the signer bit (`Unauthorized` otherwise; maps to account 0); per-meta address match at CPI time (`invoke_signed_with_slice`, PDA seeds); standard fee split on `lamports ≥ totalFee`; `increment_nonce`; log `TransactionExecuted`. Caps 64 metas / 10_240B data (tx size binds first). Token-2022 works opaquely.
- Sessions (discs 7–10; `contracts/SVM_SESSIONS.md`, canonical — ADR-010): the vault PDA above never enters game CPIs. `register_session` (owner P-256, consumes owner nonce) binds an Ed25519 session key + one allowlisted game (+ verified upgrade snapshot) into a fresh 205B session PDA (`["peridot_id","session",account_id,session_key]`, program-created for exact rent); `session_execute` (session envelope signer + strict per-session `seq`, 24h hard expiry + 30min inactivity on the chain clock) runs one game CPI signed solely by the session PDA, with exact account count (no `remaining_accounts`), bounded protected accounts hash-pinned pre/post (owner/lamports/data, incl. delegate/close_authority), and per-execution upgrade-visibility refresh (record-and-log, no enforcement); `revoke_session` (owner P-256, immediate) and `close_session` (revoked-or-expired, rent reclaimed) consume the owner nonce. Gameplay pays its own fees (no relayer split).
- Attested-fee model (explicit): the program enforces the rate, recipients, and formula over the backend-attested `networkFee` but MUST NOT pretend to determine the complete transaction fee from inside the program — the runtime deducts base fee + prioritization fees + rent from the fee payer, none of which is reliably introspectable on-chain. Attestation is quoted live, drift-bounded (≤120% of quote, fail-closed re-quote), TTL-bounded; reconciliation verifies attested ≈ actual (`meta.fee` + priority data) with alerts. The relayer absorbs spike underpayment between attest and mining.

## 6. SVM — auth plumbing

- `auth.rs::payload_hash_v3(parts)` — `sha256(DOMAIN_V3‖parts…)` into 256B stack buf; every part fixed-size LE/raw so SDK recomputes exactly. (V1/V2 hashes frozen.)
- `verify_secp256r1_v2(ix_sysvar, expected_key, expected_rp_id, clientData, payload)` — (1) next ix is secp precompile, recovered key == stored; (2) signed msg is exactly `authData‖sha256(clientData)` (≥69B); (3) `authData[0:32]==rpIdHash`, flag `0x04` set; (4) decoded challenge == payload.
- `check_expiry` — `Clock::unix_timestamp > expiry → Expired`; `expiry − now > 600 → Expired` (TTL cap bounds cross-cluster replay).
- `extract_challenge` / `base64url_decode` / `find_subslice` — same algorithm as EVM `_extractChallenge`/`_find`/`Base64Url.decode`.
- `secp256r1.rs` — vendored precompile deserializer (`num_signatures`, offsets, `get_signer/signature/message_data`); local-data only (`instruction_index == u16::MAX`).
- `sha256.rs` — pure-Rust FIPS-180-4 (`sol_sha256` crashes this SBF toolchain); tested vs `""`/`"abc"`/multiblock vectors.

## 7. Parity matrix (is `execute` == withdraw? Yes, economically)

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

## 8. Notes / verification

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
