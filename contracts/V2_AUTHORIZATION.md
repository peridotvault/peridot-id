# PeridotID V3 Authorization + Fee Schema (canonical)

Status: **canonical spec**. All EVM/SVM/SDK/backend implementations MUST match this
document byte-for-byte. V1 (`…SMART_ACCOUNT|v1`, exact-fee, unbound account/op) and
V2 (`…|v2`, signed-`maxFee` cap model) are frozen; no verifier accepts another
version's payloads.

Core invariant (never weaken for convenience):

> The relayer may submit a transaction, but it must never be able to choose who
> owns the account, what the account does, where funds go, or which fee policy
> applies beyond what the user's passkey explicitly authorized.

## 1. Canonical fee model: attested networkFee + fixed protocol percentage

Terminology (replaces `maxFee`/`base`/`markup`/`relayFee` — do not mix vocabularies):

- `networkFee`: realtime network cost attested by the backend at submit time
  (lamports / wei). On EVM the contract additionally sanity-bounds it against
  measured gas (see §5); on Solana it is purely attested (the program cannot
  observe the runtime-deducted fee — accepted, enforced by formula + reconciliation).
- `protocolFeeBps`: fixed configurable protocol percentage in basis points,
  selected by the signed `feePolicyVersion` via an immutable on-chain table.
  Policy v1: **5000 bps (50%)**; `MAX_PROTOCOL_FEE_BPS = 5000`.
- `relayerFee = networkFee` (exact): reimbursement to the actual submitter/fee payer.
- `protocolFee = floor(networkFee × protocolFeeBps / 10_000)` (u128 intermediate
  on SVM, uint256 on EVM; floor favors the user; `relayerFee + protocolFee` never
  exceeds `networkFee + protocolFee` by construction — no dust loss).
- `totalFee = relayerFee + protocolFee` (additive: e.g. network 0.001 ETH at 50%
  → relayer 0.001, revenue 0.0005, user debited 0.0015; gas up/down moves both).

What the passkey signs: the full transaction intent (account, op-tag, nonce,
destination, value, calldata-hash, chain semantics, deadline/TTL) plus
**`feePolicyVersion` only — no amounts**. The percentage is protocol-fixed, so a
relayer cannot change what the user pays *in rate*; amounts float with gas by
design. There is deliberately no user-signed amount cap (locked decision):
over-attestation is bounded by `InsufficientFunds` (balance), the 120%-quote drift
rule (§7), TTL, and reconciliation alerts — trust-but-verify on the *number*,
cryptographic enforcement on the *rate*, recipients, and semantics.

## 2. Domains and operation tags (unchanged values, new domain)

| Chain | V3 domain (exact ASCII) |
|---|---|
| EVM | `PID\|EVM\|SMART_ACCOUNT\|v3` |
| SVM | `PID\|SOLANA\|SMART_ACCOUNT\|v3` |

Op-tags unchanged (`0x00` init, `0x01` spend, `0x02` token spend, `0x03` rotate,
`0x04` close, `0x05` activate), plus `0x06` SVM generic `execute` (disc 6;
EVM `execute` keeps its own `0x01`). V2 signatures can never verify as V3.

## 3. EVM payloads (`keccak256`, `abi.encodePacked` field order)

Common types: `opTag` = `uint8`, `chainid` = `uint256`, `account` = `address`,
`nonce` = `uint64`, `deadline` = `uint64`, `feePolicyVersion` = `uint16`.
Call args additionally carry unattested `networkFee` (`uint256`); the contract
recomputes `protocolFee` from the table and enforces the split.

### 3.1 `execute`
`keccak256(DOMAIN_V3 ‖ 0x01 ‖ chainid ‖ account ‖ nonce ‖ to ‖ value ‖
keccak256(data) ‖ deadline ‖ feePolicyVersion)`.

### 3.2 `updateAuthority`
`keccak256(DOMAIN_V3 ‖ 0x03 ‖ chainid ‖ account ‖ nonce ‖ newX ‖ newY ‖
deadline)` — no fee fields.

### 3.3 Activation (`deployAndInit`)
`keccak256(DOMAIN_V3 ‖ 0x05 ‖ salt ‖ x ‖ y ‖ rpIdHash ‖ feePolicyVersion ‖
deadline ‖ chainid ‖ factory)` — signed by the **new** key. Factory checks
`msg.sender == relayer` AND the account verifies the authorization before any
state write; factory passes its caller as the relayerFee recipient.

## 4. SVM payloads (`sha256`, little-endian fixed fields)

Common types: `opTag` 1B, `account_id` 32B, nonce `u64LE`, expiry `i64LE`,
`feePolicyVersion` `u16LE`. Instruction data carries unattested `networkFee`
(`u64LE`); the program recomputes `protocolFee` and enforces the split.

### 4.1 `initialize` (disc 0)
`sha256(DOMAIN_V3 ‖ 0x00 ‖ account_id ‖ authority[33] ‖ rpIdHash[32])` —
unchanged shape apart from the domain. BACKEND-gated payer.

### 4.2 `withdraw_sol` (disc 1)
`sha256(DOMAIN_V3 ‖ 0x01 ‖ account_id ‖ nonce ‖ amount ‖ dest[32] ‖ expiry ‖
feePolicyVersion)`.

### 4.3 `withdraw_token` (disc 2)
As §4.2 plus `sourceAta[32]`; program asserts source ATA owned by PDA for mint.

### 4.4 `update_authority` (disc 3) / 4.5 `close` (disc 4)
Unchanged shapes apart from the domain (no fee fields):
`… ‖ 0x03 ‖ account_id ‖ nonce ‖ new_key[33] ‖ expiry` and
`… ‖ 0x04 ‖ account_id ‖ nonce ‖ dest[32] ‖ expiry`.

### 4.6 `activate` (disc 5)
`sha256(DOMAIN_V3 ‖ 0x05 ‖ account_id ‖ authority[33] ‖ rpIdHash[32] ‖
feePolicyVersion ‖ expiry)` — BACKEND-gated relayer.

### 4.7 `execute` (disc 6, wallet parity with EVM `execute`)
Fully generic CPI with the PDA as signer; deny-list of one (target ≠ this
program — no reentrancy). Instruction data:
`nonce ‖ target[32] ‖ meta_count u8 ‖ metas meta_count×(addr[32] ‖ flags u8:
bit0 writable, bit1 signer) ‖ data_len u16 ‖ data ‖ expiry ‖ policy ‖
network_fee ‖ len ‖ clientDataJSON` (caps: 64 metas, 10_240B data; the tx size
limit binds first). The passkey signs
`sha256(DOMAIN_V3 ‖ 0x06 ‖ account_id ‖ nonce ‖ expiry ‖ feePolicyVersion ‖
call_hash)` where `call_hash = sha256` over the exact target‖metas‖data bytes —
the relayer cannot substitute the call under a valid signature. The program
additionally requires the PDA among the metas with the signer bit (bound
PDA metas map to account 0 — outer transactions deduplicate it), enforces
address match per meta at CPI time, and settles the standard fee split
(`lamports ≥ totalFee`; the call itself moves no SOL — inner programs debit
their own accounts). Token-2022 needs no special case (target is opaque bytes).

## 5. Settlement + EVM gas sanity (both chains, atomic single tx)

- EVM `execute`: `startGas = gasleft()` at entry; after the user call,
  `measured = startGas − gasleft()`; sanity `networkFee ≤ measured ×
  tx.gasprice × 2 + l1Allowance(chainid)` else revert (`GasAnomaly`; 2× headroom
  covers verification/payout overhead and testnet L2 data fees — a bound, not
  pricing). Then require `balance ≥ value + totalFee`; pay `relayerFee →
  msg.sender`, `protocolFee → address(factory)`; single transaction, no second
  distribution tx (the extra external call's gas is the accepted incremental cost).
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

## 6. Factory revenue administration (EVM only)

The factory **accumulates native revenue directly** (`receive() payable`) and
exposes: `addAdmin(address)` / `removeAdmin(address)` (existing admin only,
floor of ≥1 admin — removing the last reverts; events `AdminAdded /
AdminRemoved`) and `withdrawRevenue(destination, amount)` (admin only,
`amount ≤ balance`, event `RevenueWithdrawn`). Initial admins come from the
constructor. Hard prohibitions: no per-call treasury (the vault IS the
factory); no function touching user accounts, authorities, nonces, or fee
policy; no upgrade/selfdestruct/pause. Factory is never a wallet authority.
Deployer retains nothing after construction.

## 7. Quote / drift / TTL / failure rules

- Quote returns `{networkFee (realtime estimate), protocolFeeBps,
  feePolicyVersion, totalFee, chainTime}`. Backend recomputes attested
  `networkFee` at submit (EVM: live gas price × estimate + L1 data fee via
  chain oracle where available; SVM: `getFeeForMessage` on the exact message
  shape — same ix layout, signer count, and (for execute) target/metas/data
  length — so quotes track `meta.fee` 1:1; no priority fees anywhere).
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

## 8. Determinism (unchanged)

EVM tuple: canonical PID normalization/hash + salt + factory + implementation +
clone initcode (chainId binds signatures only). SVM tuple: canonical PID
normalization/hash + seeds + program ID (BACKEND/TREASURY/vault/RPC never enter
derivation). State, nonce, balances, history stay chain-local. New factory
bytecode ⇒ new factory/account addresses (testnet reset; nothing on mainnet).
