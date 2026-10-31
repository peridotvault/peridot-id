# AC712 operator — passkey EXECUTE (AC2.8) + token-deny (AC3.4)

Testnet-only operator tooling for ANT-712 (never mainnet, not part of the
published `@peridotvault/pid-stellar` SDK). Node + `@stellar/stellar-sdk`
17.x for envelopes/XDR, `@noble/curves` for secp256r1 prehash signing.

## What it proves (all on testnet, 2026-10-27)

| Step | Command | Result |
|---|---|---|
| `add-rule` | `node run.mjs add-rule <priv> <pub>` | rule 1 `nonfinancial-only` + policy v1 installed, passkey self-auth (tx `ad4a4915…`, verifier `verify=true` on-chain) |
| `add-rule` (v2) | `POLICY=<v2> RULE_NAME=nonfinancial-only-v2 …` | rule 2 with layer-2 policy (tx `425259c6…`) |
| `execute` | `node run.mjs execute <pub> <priv>` | `execute(verifier, canonicalize_key, …)` via External signer (tx `f7ac3032…`, SUCCESS, `verify=true`) |
| `replay` | `node run.mjs replay <exec.json> <priv>` | same assertion, fresh envelope → enforce-sim `#3114 ChallengeInvalid`, submitted tx `5defe5cb…` FAILED with on-chain `#3114` |
| `deny` | `RULE_ID=2 node run.mjs deny <priv> <pub>` | decimals probe `34887291…` SUCCESS (rule authorizes, policy passes nonfinancial), then `execute(SAC, transfer, …)` → enforce-sim contract `#1`, submitted tx `cdfc24ad…` FAILED with on-chain `UnauthorizedFinancialOp` |

Reference actors (testnet-only): pilot `CA2XGFLW…LAB36` (passkey-only rule 0),
verifier `CD7HL6U…LQLL7QXSDB` (Phase-0, reused — confirmed live, no redeploy),
policy v1 `CDCPKVIJ…7QZYVP`, policy v2 `CBMNKK7T…DZAMPAD5`, native SAC
`CDLZFC3S…YGCYSC`, operator/relayer key funds faucet XLM and pays fees.

G1 (digest byte-equality): on-chain `auth_digest(preimage)` for the real
execute preimage == `authDigestHex()` over the submitted envelope's
`(nonce, expiration, invocation)` == the digest the passkey signed
(`8bf61223…2824b9` for the reference execute). Recompute any run with the
`g1` pattern in this guide's history (envelope → sigPayload → digest).

## Run

```sh
cd contracts/stellar/account/scripts/ac712
npm install   # isolated; not part of the pnpm workspace
export RPC_URL=https://soroban-testnet.stellar.org
export NETWORK_PASSPHRASE='Test SDF Network ; September 2015'
export PILOT=<passkey-only pilot> VERIFIER=<webauthn verifier>
export POLICY=<policy> SAC=<native SAC>
export RELAYER_SVM_SECRET_KEY=<operator ed25519 secret>   # fee payer only (relayer pattern; matches contracts/.env.example)
export PUB65_HEX=<65B uncompressed secp256r1 pubkey hex>
node run.mjs keygen   # fresh operator key (fund via friendbot)
node --test "test/*.test.mjs"   # 10 unit tests (determinism + shapes; chain is the truth gate)
```

## Findings worth keeping (host/SDK behavior, all observed live)

1. **OZ no-policy rules require ALL signers** (`get_validated_context_by_id`:
   without policies, `rule_signers.len() != matched.len()` → `#3002
   UnvalidatedContext`). Passkey-only flows therefore want single-External-
   signer rules; multi-signer rules need every signer in each payload.
2. **`execute` cannot target its own account** — a self-call traps with
   `Context/InvalidAction` (reentry) before auth runs. AC2.8 uses the
   verifier's read-only `canonicalize_key` as the target.
3. **Policy context is the authorized root, not the sub-call**: `enforce`
   sees `execute(SAC, transfer, …)`, never a bare `transfer`. The
   nonfinancial policy therefore judges the execute *dispatch* (layer 2:
   target-fn denylist) as well as the direct fn name (layer 1).
4. **Record-mode footprints skip `__check_auth` reads and under-budget auth
   crypto.** Negative-path submissions assemble the *enforce* footprint of a
   same-rule passing call (padded ×4 instructions) instead of the probe
   footprint — otherwise the chain dies with `resource_limit_exceeded` /
   `storage exceeded_limit` before reaching the deny logic.
5. **Auth entries must be passed at op construction** (`Operation.
   invokeContractFunction({…, auth })`); post-hoc `tx.operations[0].auth = …`
   does not serialize (verified by XDR roundtrip). `assembleTransaction`
   keeps construction-time auths ("advanced usage").
6. **V1 address credentials** (`useUpgradedAuth=false`) match the OZ-test
   shape the host accepts for custom accounts.
7. **Classic payments cannot fund contract addresses** (`MuxedAccount` is
   ed25519-only), so the deny uses amount 0 — immaterial to the gate, which
   fires on fn-name during `__check_auth` before the token executes.
8. **Delegated (G-key) nested self-auth — DIAGNOSED (ANT-716, construction
    bug, operator-side fix in `lib.mjs`)**: the nested entry's credential
    signature for an Account (G-address) delegate must be
    `Vec<AccountEd25519Signature>` — one `ScMap{public_key: Bytes(32),
    signature: Bytes(64)}` per signer, signing the 32-byte *nested*
    `signature_payload` hash — exactly what the host's
    `check_account_authentication` (env-host 28.0.2) parses. Raw `Bytes` (or
    `Void`, the OZ-test contract-delegate pattern) dies with
    `Value/UnexpectedType` → `Auth/InvalidAction` despite a byte-matching
    outer payload; the OZ `auth_entries.rs` tests only ever exercise
    *contract* delegates (host routes those to `__check_auth` without parsing
    the signature), never a real ed25519 nested signature. Live testnet proof
    (enforce-sim vs pilot #2): raw-Bytes nested sig → `UnexpectedType`;
    same entry with `AccountEd25519Signature` shape (zero sig) → reaches
    `failed ED25519 verification`; correct shape + valid sig passes in
    try-runtime (host 28.0.2). New builders:
    `delegatedAccountSigVecScVal` + `delegatedNestedInvocation` (+ unit
    tests). Full delegated operator flow still needs a live Delegated(G) rule
    with a known secret for a testnet green run — follow-up, not a gate (all
    AC2.8/AC3.4 flows stay passkey-only single-entry).
