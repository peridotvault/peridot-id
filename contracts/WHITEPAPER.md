# PeridotID Smart-Account Whitepaper (contracts)

Scope: `contracts/evm` (Solidity) vs `contracts/svm/smart-account` (Pinocchio/Rust).
Status: **counterparts, not identical** — same passkey-owned model, different chain mechanics.

## 1. Shared model

- Authority = secp256r1 (P-256) WebAuthn passkey. 1 PID = 1 account. Rotation never moves the address.
- Every sensitive op signs a domain-separated payload placed in the WebAuthn `challenge` (base64url, no padding). Program/contract recomputes it from its own args → blocks substitution.
- Signed message = `authenticatorData ‖ sha256(clientDataJSON)`.
- Replay guard = `nonce` (checked then incremented). Expiry enforced on-chain with short TTLs (~5 minutes).
- Challenge parsing is duplicated per chain: find `"challenge":"…"`, base64url-decode, require 32 bytes.
- Sponsored-relayer model (canonical): Peridot sponsors transaction submission — the relayer pays network fees, the user authorizes the operation **and an absolute `maxFee`** with their passkey, reimbursement never exceeds `maxFee`, and the protocol markup goes to one canonical treasury. The relayer is never an authority over user funds.
- Fee semantics (both chains): the user signs an absolute `maxFee`, never an exact relayer-chosen fee. The applicable `markupBps` comes from the protocol fee policy, subject to a protocol-enforced on-chain maximum markup. Base reimbursement goes to the transaction fee payer (EVM `msg.sender` / SVM relayer signer); markup goes to the single canonical treasury. No per-call arbitrary treasury (`treasuryId` unnecessary for V1).
- Cross-cluster validity (explicit V1 trade-off, not an omission): the same PID derives to the same Solana PDA across devnet/testnet/mainnet, so no cluster ID / genesis hash enters the signed payload in V1. An otherwise-valid SVM signature may be valid across clusters until its nonce is consumed or it expires — bounded by short expiries. EVM signatures stay chain-bound via `chainid`.

| | SVM | EVM |
|---|---|---|
| Domain | `PID\|SOLANA\|SMART_ACCOUNT\|v1` (`auth.rs::DOMAIN`, mirrors `packages/core/src/hash.ts::DOMAIN`) | `PID\|EVM\|SMART_ACCOUNT\|v1` (`PeridotAccount.DOMAIN`, mirrors `packages/core/src/evm.ts::DOMAIN_EVM`) |
| Payload hash | `sha256(DOMAIN‖LE fields)` (`auth.rs::payload_hash`) | `keccak256(DOMAIN‖chainid‖account‖…)` (`execute`/`updateAuthority`) |
| Authority encoding | 33B compressed key in 80B PDA state (`state.rs`) | `bytes32 x, y` + `bytes32 rpIdHash` storage (`PeridotAccount.sol`) |
| Sig verify | Secp256r1 precompile + Instructions-sysvar introspection (next ix), signer == stored (`auth.rs::verify_secp256r1`, `secp256r1.rs`) | Direct `P256.verify` (OZ, RIP-7212/fallback, low-S inside) + on-chain RP-ID hash + UV-flag `0x04` (`_verify`) |
| Address | PDA `["peridot_id","account",sha256(pid)]`, program `CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT` — deterministic per (seeds, program id); **one program keypair on every cluster → one address everywhere** | CREATE2 EIP-1167 proxy, `salt = bytes32(pidToSeed32(pid))`, same factory+impl → same address every chain |
| Clock | `Clock` sysvar, `i64 expiry` | `block.timestamp`, `u64 deadline` |
| Fee model | Cap-based sponsorship: relayer floats fee, program enforces user-signed `maxFee`; base→fee payer (relayer signer), markup→single canonical treasury. Quote/reconcile off-chain; no on-chain fee introspection | Same split: base→`msg.sender`, markup→canonical treasury; `maxFee` enforced on-chain; L2 actual cost attested + capped + reconciled off-chain in V1 |
| State | Fixed 80B PDA (`version‖type‖status‖nonce u64LE‖authority[33]‖account_id[32]`) | Contract storage (`authorityX/Y`, `rpIdHash`, `nonce`, `initialized`) |

## 2. EVM — `src/PeridotAccount.sol` (V1 required semantics)

- `deployAndInit` is atomic **and passkey-authorized**: the user's P-256 key signs an activation payload binding the PID/salt, authority `(x, y)`, `rpIdHash`, activation `maxFee`, fee-policy version, and deadline (plus `chainid` + factory/account). State is written only on a valid signature. A compromised relayer can neither squat an undeployed PID address, choose its authority, nor redirect activation funds.
- Bare `deploy()` + ungated `initialize()` MUST NOT exist on production deployments. `initialize` is reachable only atomically through passkey-bound `deployAndInit` (or gated to the trusted factory); the standalone relayer-only `deploy` path is removed or permanently disabled — it leaves an uninitialized proxy whose authority anyone can front-run.
- `initialize(x, y, rpIdHash, maxFee, feePolicyVersion, deadline, …assertion…)` — one-time setup (factory calls it atomically with the user's activation signature). Reverts `AlreadyInitialized` / `ZeroAuthority` / cap-policy violations. Pre-funded counterfactual (first-top-up, SVM `activate` parity): reimbursement bounded by the signed activation `maxFee` — base→`msg.sender`, markup→canonical treasury — never an exact relayer-chosen fee to an arbitrary address. Emits `Initialized(x, y, settledBase, settledMarkup)`. No constructor args so impl redeploys at one address (keyless CREATE2).
- `receive()` — accept plain ETH.
- `execute(to, value, data, deadline, maxFee, feePolicyVersion, …)` — mirrors SVM `withdraw_sol`: relayer submits/floats gas, contract enforces `settled ≤ maxFee`, base reimbursement→`msg.sender` (the fee payer), markup→canonical treasury. `maxFee` + policy version are inside the signed payload (the relayer cannot charge above user authorization). Order: `initialized`, `Expired`, cap/policy checks, `_verify`, then `InsufficientFunds` (`balance ≥ value+settled`, auth errors first — SVM order), `nonce++`, `to.call{value}(data)`, split payouts, `Executed(to, value, settledBase, settledMarkup, n)`. `chainid`+`address(this)` bind replay to this chain+account.
- L2 actual cost (V1): attested + capped + reconciled. No universal on-chain actual-cost calculation for Arbitrum / Base / OP-Stack in V1. The backend/indexer computes actual network cost from the confirmed transaction/receipt plus L2 fee data; the contract enforces the user's absolute `maxFee`; reconciliation verifies the settled amount is within fee policy and the signed cap. Per-chain oracle/precompile accounting may be added later as a chain-specific optimization after each target chain's fee mechanism and oracle version are formally pinned.
- `_executePayload(…)` — own frame for the `keccak256(DOMAIN‖chainid‖this‖nonce‖to‖value‖keccak256(data)‖deadline‖maxFee‖feePolicyVersion)` hash (legacy codegen stack limit; `via_ir = true`).
- `updateAuthority(newX, newY, deadline, …)` — rotation, signed by **current** key. Zero-key + expiry checks, payload `keccak256(DOMAIN‖chainid‖this‖nonce‖newX‖newY‖deadline)`, writes keys, `nonce++`, emits `AuthorityUpdated`. No fee fields.
- `_verify(expected, authData, clientData, r, s)` — mirrors `auth.rs`: (1) `len ≥ 37`, `authData[0:32]==rpIdHash`, flag `authData[32]&0x04` (UV); (2) `h=sha256(authData‖sha256(clientData))`; (3) extracted challenge == expected else `InvalidChallenge`; (4) `P256.verify(h,r,s,x,y)` else `Unauthorized`.
- `_extractChallenge(json)` / `_find(haystack, needle)` — naive `"challenge":"` search (clientData small, once/tx), `Base64Url.decode`, require 32B.
- Errors: `AlreadyInitialized/NotInitialized/Unauthorized/InvalidChallenge/Expired/CallFailed/ZeroAuthority` plus cap/policy violations (`FeeExceedsMax/UnknownFeePolicy`); no per-call `ZeroTreasury` — the treasury is canonical, not caller-supplied.

## 3. EVM — `src/Base64Url.sol`, `src/PeridotFactory.sol`

- `Base64Url.decode(input)` — minimal RFC-4648§5 no-padding decoder (`A-Z/a-z/0-9/-/_`), reverts `InvalidChar` (incl. `len%4==1`). Only what challenge parsing needs.
- `PeridotFactory.deployAndInit(salt, x, y, rpIdHash, maxFee, feePolicyVersion, deadline, …assertion…)` — **relayer-submitted but user-authorized**: requires `msg.sender == relayer` AND a valid passkey signature binding `(salt, x, y, rpIdHash, maxFee, feePolicyVersion, deadline, chainid, factory)`; `updateRelayer` rotates (current relayer only; zero disables). `predict(salt)` stays open (view).
- Production MUST NOT expose bare `deploy(salt)`: a deployed-but-uninitialized proxy plus ungated `initialize` is a squat vector (counterfactual address + prefund + front-runnable authority). The path is removed or permanently disabled; tests must not depend on it.
- API never trusts code-presence: `poll()`/`viewOf()` promote to `active` only on exact `initialized + authorityX/Y + rpIdHash` match; mismatches demote + warn (squat signal).
- `deployAndInit(…)` — clone + passkey-bound `initialize` atomically (no front-run window on authority or fee). `InitFailed` on bad init; cap/policy failures revert before any state write.
- `predict(salt)` — counterfactual address (`Clones.predictDeterministicAddress`); must stay byte-identical to `deriveEvmSmartAccountAddress` (`@peridotvault/pid-evm`, forge parity test).
- Fee policy: the protocol exposes one canonical treasury plus per-version `markupBps` subject to an on-chain `maxMarkupBps` maximum. The user-signed `maxFee` caps every activation and execution. No per-call treasury address (`treasuryId` unnecessary for V1).

## 4. SVM — dispatch + state

- `lib.rs::process_instruction` — checks program id, splits discriminator byte → `Instruction::{Initialize=0, WithdrawSol=1, WithdrawToken=2, UpdateAuthority=3, Close=4, Activate=5}` → handler. No Ed25519 fallback in V1 path despite header comment; authority is secp256r1 via precompile.
- `state.rs::SmartAccount` (read) / `SmartAccountMut` (write) — `try_from_bytes` (len 80, version 1), `authority()`, `account_id()`, `nonce()`, `initialize(id,key)`, `set_authority`, `increment_nonce`.
- `verify_pda(account, program, account_id)` — real `find_program_address` on-chain; host stub returns 255 (covered by integration suite, not units).
- `verify_nonce` — `state.nonce == ix.nonce` else `InvalidNonce`.
- `errors.rs::PeridotError`: `AlreadyInitialized/Uninitialized/Unauthorized/InvalidNonce/InvalidPda/NotSigner/WrongOwner/InvalidDestination/InsufficientFunds/Expired/InvalidChallenge/Forbidden` (`Forbidden` = non-backend creation attempt), extended with cap/policy errors for `maxFee` enforcement (`FeeExceedsMax/UnknownFeePolicy`).

## 5. SVM — instructions

- `initialize` (BACKEND payer SIGNER, PDA WRITE, system, sysvar): payer == `config::BACKEND` (`Forbidden` otherwise — PID-ownership proof), PDA empty check, `verify_pda`, passkey auth over `sha256(DOMAIN‖account_id‖authority)`, `create_account…_signed`, write state, log `AccountInitialized`. Only the new authority's key + the backend together can claim — no squat.
- `withdraw_sol` (PDA, dest, relayer SIGNER, instructions sysvar; recipients are canonical, not per-call accounts): relayer signer (any submitter — payload is fully bound), owner/init/dest≠self checks, dest addr == arg check, nonce+PDA verify, payload `sha256(DOMAIN‖nonce‖amount‖dest‖expiry‖maxFee‖feePolicyVersion)` (cap + policy bound — no fee above user authorization), `check_expiry`, `verify_secp256r1`, enforce `settled ≤ maxFee`, `lamports ≥ amount+settled`, split lamport moves (base→relayer signer/fee payer, markup→canonical treasury; no System CPI — PDA carries data), `increment_nonce`, log `TransactionExecuted`.
- `withdraw_token` (+source ATA, mint, dest ATA, token program): same cap-based auth with `dest_ata` **+ source ATA** in payload; SPL `Transfer` CPI signed by PDA seeds for `amount`; SOL reimbursement split base/markup bounded by `maxFee`; `lamports ≥ settled` only (token balance enforced by token program).
- `update_authority` (PDA, sysvar): payload `sha256(DOMAIN‖nonce‖new_key[33]‖expiry)`, verified by **current** key, then `set_authority` + `increment_nonce`, log `AuthorityUpdated`.
- `close` (PDA, dest, sysvar): payload binds `dest` (`nonce‖dest‖expiry`); drains all lamports to dest, `account.close()`, log `AccountClosed`. Teardown only — no V1 API (ADR-004).
- `activate` (BACKEND relayer SIGNER, PDA, system, sysvar): sponsored claim, **relayer == BACKEND** (`Forbidden` otherwise) + passkey auth over `sha256(DOMAIN‖account_id‖authority‖maxFee‖feePolicyVersion‖expiry)`. Rejects already-program-owned/non-empty; `create_account…_signed` creates (empty) or tops-up→assigns (pre-funded deposit); requires `lamports ≥ rent + settled`; splits base→relayer, markup→canonical treasury; writes state; log `AccountActivated`.
- Cap-based reimbursement (explicit): the program enforces the user-signed `maxFee` and signed parameters but MUST NOT pretend to determine the complete transaction fee from inside the program — the runtime deducts base fee + prioritization fees + rent from the fee payer, none of which is reliably introspectable on-chain. Quoting and reconciliation happen off-chain from transaction metadata and fee/priority-fee data. The relayer may temporarily absorb underpayment caused by fee spikes, while overpayment is bounded by `maxFee`. The program never accepts a fee above the user's authorization.

## 6. SVM — auth plumbing

- `auth.rs::payload_hash(parts)` — `sha256(DOMAIN‖parts…)` into 256B stack buf; every part fixed-size LE/raw so SDK recomputes exactly.
- `verify_secp256r1(ix_sysvar, expected_key, clientData, payload)` — (1) next ix is secp precompile, recovered key == stored; (2) signed msg ends with `sha256(clientData)`; (3) decoded challenge == payload. No RP-ID/UV-flag check on-chain (client-side; EVM enforces them because it is cheap there).
- Fee/policy binding: spend and activation payloads bind `maxFee` + `feePolicyVersion` (see §2, §5); the program/contract checks the policy version is known and `settled ≤ maxFee` before moving funds.
- No cluster binding in V1 (explicit): SVM payloads carry no cluster ID / genesis hash so one PID keeps one PDA and one signature semantic across devnet/testnet/mainnet. Cross-cluster validity is bounded by short expiries + nonce consumption (see §1).
- `check_expiry` — `Clock::unix_timestamp > expiry → Expired`.
- `extract_challenge` / `base64url_decode` / `find_subslice` — same algorithm as EVM `_extractChallenge`/`_find`/`Base64Url.decode`.
- `secp256r1.rs` — vendored precompile deserializer (`num_signatures`, offsets, `get_signer/signature/message_data`); local-data only (`instruction_index == u16::MAX`).
- `sha256.rs` — pure-Rust FIPS-180-4 (`sol_sha256` crashes this SBF toolchain); tested vs `""`/`"abc"`/multiblock vectors.

## 7. Parity matrix (is `execute` == withdraw? Yes, economically)

| Function | Same? | Note |
|---|---|---|
| init (`initialize` both) | Roughly | Both one-time + zero-key guard + co-signed claim (SVM: BACKEND + passkey; EVM: relayer-submitted + passkey-bound `deployAndInit`); SVM creates PDA via CPI, EVM called by factory proxy |
| spend (`execute` vs `withdraw_sol/withdraw_token`) | **Yes (economics)** | User-signed absolute `maxFee` + policy `markupBps` (≤ on-chain maximum); base→fee payer, markup→canonical treasury; EVM one generic call vs two typed handlers |
| `updateAuthority` both | **Yes, closest match** | Same nonce/expiry/challenge flow, signed by current key |
| challenge/base64/find | **Yes (logic)** | Duplicated implementations, same algorithm |
| sig verify | **No (mechanism)** | Precompile-introspection vs `P256.verify` + RP-ID/UV |
| `activate` fee vs `deployAndInit` fee | **Yes** | Both bounded by signed activation `maxFee` + policy version; settled base→relayer, markup→canonical treasury |
| `close` | SVM-only | Teardown, no V1 API; no EVM equivalent |
| factory `deploy/predict` | EVM-only | No SVM equivalent (PDA is implicit); bare `deploy` removed/disabled in production, `predict` stays |

## 8. Notes / verification

- Low-S enforced both sides (SVM precompile, EVM OZ lib); SVM needs `skipPreflight` (no simulate), EVM high-S test asserts revert.
- `sol_sha256` crash → pure-Rust SHA-256; expiries use chain clocks, not device time. Signature TTLs stay short (~5 minutes) — the primary bound on cross-cluster validity (see §1).
- Sponsored model is canonical: Peridot sponsors submission, the user authorizes the operation and maximum reimbursement with a passkey, the relayer pays network fees, reimbursement is bounded by `maxFee`, and the protocol markup goes to the canonical treasury. ADRs/PRDs/architecture/security/SDK docs MUST be amended to this model; no revert to the old client-fee-payer model.
- Reconciliation (both chains): backend/indexer verifies `settled ≤ maxFee` and within fee policy from confirmed transaction metadata (EVM receipts + L2 fee data; Solana `meta.fee` + priority-fee data), with alerts on divergence. Underpayment from fee spikes is absorbed by the relayer; overpayment is bounded by the signed cap.
- Verify: `cd contracts/evm && forge test` (passkey-bound `deployAndInit`, squat-attempt, cap/policy, canonical-treasury cases) · `cd contracts/svm/smart-account && PID_BACKEND=<key> cargo build-sbf && cargo test` + `node tests/integration.mjs <id>` (squat/Forbidden/cap cases) + `node ../../packages/solana/test/adapter.e2e.mjs` · `pnpm typecheck`.
- Security model: creation = passkey-authorized (+ backend-gated on SVM `initialize`/`activate`; relayer-submission-gated + passkey-bound on EVM `deployAndInit`); spends = passkey-signed with fully-bound payloads (`maxFee`, policy version, canonical recipients); submission is permissionless by design. A compromised relayer may waste its own gas or submit valid user-signed intents but MUST NOT forge authority, alter bound fields, redirect funds, or settle above `maxFee`.
