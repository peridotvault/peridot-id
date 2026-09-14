# PeridotID Smart-Account Whitepaper (contracts)

Scope: `contracts/evm` (Solidity) vs `contracts/svm/smart-account` (Pinocchio/Rust).
Status: **counterparts, not identical** — same passkey-owned model, different chain mechanics.

## 1. Shared model

- Authority = secp256r1 (P-256) WebAuthn passkey. 1 PID = 1 account. Rotation never moves the address.
- Every sensitive op signs a domain-separated payload placed in the WebAuthn `challenge` (base64url, no padding). Program/contract recomputes it from its own args → blocks substitution.
- Signed message = `authenticatorData ‖ sha256(clientDataJSON)`.
- Replay guard = `nonce` (checked then incremented). Expiry enforced on-chain.
- Challenge parsing is duplicated per chain: find `"challenge":"…"`, base64url-decode, require 32 bytes.

| | SVM | EVM |
|---|---|---|
| Domain | `PID\|SOLANA\|SMART_ACCOUNT\|v1` (`auth.rs::DOMAIN`, mirrors `packages/core/src/hash.ts::DOMAIN`) | `PID\|EVM\|SMART_ACCOUNT\|v1` (`PeridotAccount.DOMAIN`, mirrors `packages/core/src/evm.ts::DOMAIN_EVM`) |
| Payload hash | `sha256(DOMAIN‖LE fields)` (`auth.rs::payload_hash`) | `keccak256(DOMAIN‖chainid‖account‖…)` (`execute`/`updateAuthority`) |
| Authority encoding | 33B compressed key in 80B PDA state (`state.rs`) | `bytes32 x, y` + `bytes32 rpIdHash` storage (`PeridotAccount.sol`) |
| Sig verify | Secp256r1 precompile + Instructions-sysvar introspection (next ix), signer == stored (`auth.rs::verify_secp256r1`, `secp256r1.rs`) | Direct `P256.verify` (OZ, RIP-7212/fallback, low-S inside) + on-chain RP-ID hash + UV-flag `0x04` (`_verify`) |
| Address | PDA `["peridot_id","account",sha256(pid)]`, program `CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT` — deterministic per (seeds, program id); **one program keypair on every cluster → one address everywhere** | CREATE2 EIP-1167 proxy, `salt = bytes32(pidToSeed32(pid))`, same factory+impl → same address every chain |
| Clock | `Clock` sysvar, `i64 expiry` | `block.timestamp`, `u64 deadline` |
| Fee model | Relayer floats fee, `relay_fee`/`activation_fee` reimbursed to treasury from PDA | Same: `relayFee`→treasury on `execute`, `activationFee`→treasury on `deployAndInit` (both from account balance) |
| State | Fixed 80B PDA (`version‖type‖status‖nonce u64LE‖authority[33]‖account_id[32]`) | Contract storage (`authorityX/Y`, `rpIdHash`, `nonce`, `initialized`) |

## 2. EVM — `src/PeridotAccount.sol`

- `initialize(x, y, rpIdHash, activationFee, treasury)` — one-time setup (factory calls it atomically). Reverts `AlreadyInitialized` / `ZeroAuthority`. Pre-funded counterfactual (first-top-up, SVM `activate` parity): pulls `activationFee` to `treasury`, `0` skips (`ZeroTreasury` / `InsufficientFunds`). Emits `Initialized(x, y, activationFee)`. No constructor args so impl redeploys at one address (keyless CREATE2).
- `receive()` — accept plain ETH.
- `execute(to, value, data, deadline, relayFee, treasury, …)` — mirrors SVM `withdraw_sol`: relayer submits/floats gas, `relayFee` reimbursed to `treasury` from balance, fee inside the signed payload (no overcharge). Order: `initialized`, `Expired`, `ZeroTreasury`, `_verify`, then `InsufficientFunds` (`balance ≥ value+fee`, auth errors first — SVM order), `nonce++`, `to.call{value}(data)`, fee payout, `Executed(to, value, relayFee, n)`. `chainid`+`address(this)` bind replay to this chain+account.
- `_executePayload(…)` — own frame for the `keccak256(DOMAIN‖chainid‖this‖nonce‖to‖value‖keccak256(data)‖deadline‖relayFee‖treasury)` hash (legacy codegen stack limit; `via_ir = true`).
- `updateAuthority(newX, newY, deadline, …)` — rotation, signed by **current** key. Zero-key + expiry checks, payload `keccak256(DOMAIN‖chainid‖this‖nonce‖newX‖newY‖deadline)`, writes keys, `nonce++`, emits `AuthorityUpdated`.
- `_verify(expected, authData, clientData, r, s)` — mirrors `auth.rs`: (1) `len ≥ 37`, `authData[0:32]==rpIdHash`, flag `authData[32]&0x04` (UV); (2) `h=sha256(authData‖sha256(clientData))`; (3) extracted challenge == expected else `InvalidChallenge`; (4) `P256.verify(h,r,s,x,y)` else `Unauthorized`.
- `_extractChallenge(json)` / `_find(haystack, needle)` — naive `"challenge":"` search (clientData small, once/tx), `Base64Url.decode`, require 32B.
- Errors: `AlreadyInitialized/NotInitialized/Unauthorized/InvalidChallenge/Expired/CallFailed/ZeroAuthority`.

## 3. EVM — `src/Base64Url.sol`, `src/PeridotFactory.sol`

- `Base64Url.decode(input)` — minimal RFC-4648§5 no-padding decoder (`A-Z/a-z/0-9/-/_`), reverts `InvalidChar` (incl. `len%4==1`). Only what challenge parsing needs.
- `PeridotFactory.deploy(salt)` — `Clones.cloneDeterministic(impl, salt)`, emits `Deployed`. Reverts if taken.
- `deployAndInit(salt, x, y, rpIdHash, activationFee, treasury)` — clone + `initialize` atomically (no front-run window). `InitFailed` on bad init.
- `predict(salt)` — counterfactual address (`Clones.predictDeterministicAddress`); must stay byte-identical to `deriveEvmSmartAccountAddress` (`@peridotvault/pid-evm`, forge parity test).

## 4. SVM — dispatch + state

- `lib.rs::process_instruction` — checks program id, splits discriminator byte → `Instruction::{Initialize=0, WithdrawSol=1, WithdrawToken=2, UpdateAuthority=3, Close=4, Activate=5}` → handler. No Ed25519 fallback in V1 path despite header comment; authority is secp256r1 via precompile.
- `state.rs::SmartAccount` (read) / `SmartAccountMut` (write) — `try_from_bytes` (len 80, version 1), `authority()`, `account_id()`, `nonce()`, `initialize(id,key)`, `set_authority`, `increment_nonce`.
- `verify_pda(account, program, account_id)` — real `find_program_address` on-chain; host stub returns 255 (covered by integration suite, not units).
- `verify_nonce` — `state.nonce == ix.nonce` else `InvalidNonce`.
- `errors.rs::PeridotError` 0–10: `AlreadyInitialized/Uninitialized/Unauthorized/InvalidNonce/InvalidPda/NotSigner/WrongOwner/InvalidDestination/InsufficientFunds/Expired/InvalidChallenge`.

## 5. SVM — instructions

- `initialize` (payer SIGNER, PDA WRITE, system): payer signer check, PDA empty check, read `account_id[32]‖authority[33]`, `verify_pda`, `create_account_with_minimum_balance_signed` (PDA signs via seeds), write state, log `AccountInitialized`.
- `withdraw_sol` (PDA, dest, treasury, relayer SIGNER, instructions sysvar): relayer signer, owner/init/dest≠self checks, dest addr == arg check, nonce+PDA verify, payload `sha256(DOMAIN‖nonce‖amount‖dest‖expiry‖relay_fee)`, `check_expiry`, `verify_secp256r1`, `lamports ≥ amount+fee`, direct lamport moves (no System CPI — PDA carries data), `increment_nonce`, log `TransactionExecuted`.
- `withdraw_token` (+source ATA, mint, dest ATA, token program): same auth with `dest_ata` in payload; SPL `Transfer` CPI signed by PDA seeds for `amount`; SOL `relay_fee`→treasury by lamport mutation; `lamports ≥ fee` only (token balance enforced by token program).
- `update_authority` (PDA, sysvar): payload `sha256(DOMAIN‖nonce‖new_key[33]‖expiry)`, verified by **current** key, then `set_authority` + `increment_nonce`, log `AuthorityUpdated`.
- `close` (PDA, dest, sysvar): payload binds `dest` (`nonce‖dest‖expiry`); drains all lamports to dest, `account.close()`, log `AccountClosed`. Teardown only — no V1 API (ADR-004).
- `activate` (relayer SIGNER, PDA, treasury, system): sponsored claim. Rejects already-program-owned/non-empty; `create_account…_signed` creates (empty) or tops-up→assigns (pre-funded deposit); requires `lamports ≥ rent + activation_fee`; moves fee to treasury; writes state; log `AccountActivated`.

## 6. SVM — auth plumbing

- `auth.rs::payload_hash(parts)` — `sha256(DOMAIN‖parts…)` into 256B stack buf; every part fixed-size LE/raw so SDK recomputes exactly.
- `verify_secp256r1(ix_sysvar, expected_key, clientData, payload)` — (1) next ix is secp precompile, recovered key == stored; (2) signed msg ends with `sha256(clientData)`; (3) decoded challenge == payload. No RP-ID/UV-flag check on-chain (client-side; EVM enforces them because it is cheap there).
- `check_expiry` — `Clock::unix_timestamp > expiry → Expired`.
- `extract_challenge` / `base64url_decode` / `find_subslice` — same algorithm as EVM `_extractChallenge`/`_find`/`Base64Url.decode`.
- `secp256r1.rs` — vendored precompile deserializer (`num_signatures`, offsets, `get_signer/signature/message_data`); local-data only (`instruction_index == u16::MAX`).
- `sha256.rs` — pure-Rust FIPS-180-4 (`sol_sha256` crashes this SBF toolchain); tested vs `""`/`"abc"`/multiblock vectors.

## 7. Parity matrix (is `execute` == withdraw? Yes, economically)

| Function | Same? | Note |
|---|---|---|
| init (`initialize` both) | Roughly | Both one-time + zero-key guard; SVM creates PDA via CPI, EVM called by factory proxy |
| spend (`execute` vs `withdraw_sol/withdraw_token`) | **Yes (economics)** | Fee signed in-payload, reimbursed to treasury from balance both sides; EVM one generic call vs two typed handlers |
| `updateAuthority` both | **Yes, closest match** | Same nonce/expiry/challenge flow, signed by current key |
| challenge/base64/find | **Yes (logic)** | Duplicated implementations, same algorithm |
| sig verify | **No (mechanism)** | Precompile-introspection vs `P256.verify` + RP-ID/UV |
| `activate` fee vs `deployAndInit` fee | **Yes** | Both pull the activation fee from the pre-funded account to treasury at claim |
| `close` | SVM-only | Teardown, no V1 API; no EVM equivalent |
| factory `deploy/predict` | EVM-only | No SVM equivalent (PDA is implicit) |

## 8. Notes / verification

- Low-S enforced both sides (SVM precompile, EVM OZ lib); SVM needs `skipPreflight` (no simulate), EVM high-S test asserts revert.
- `sol_sha256` crash → pure-Rust SHA-256; expiries use chain clocks, not device time.
- Verify: `cd contracts/evm && forge test` · `cd contracts/svm/smart-account && cargo test` (12) + `node tests/integration.mjs <id>` (13) · `pnpm typecheck`.
