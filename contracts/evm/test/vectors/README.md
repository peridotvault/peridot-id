# V3 test vectors (`PeridotAccount.t.sol`)

Happy-path tests use real P-256 signatures by privkey 1 (pubkey = generator G).
To regenerate after touching any V3 payload layout:

1. `forge test --match-test 'test_LogVector*' -vv` → prints each `payload` and the
   message digest `h = sha256(authData ‖ sha256(clientData))`, plus the predicted
   account/factory addresses. Test context is fixed: `vm.warp(1_000_000)`,
   `DEADLINE = 1_000_300`, chainid 31337, `SALT = bytes32(7)`, `rpIdHash =
   sha256("localhost")`, `NETWORK_FEE = 0.01 ether`, `POLICY = 1`.
   Set an explicit gas price in-vector tests via `vm.txGasPrice(...)`: the V3
   `GasAnomaly` sanity bound divides by `tx.gasprice`, and forge defaults it to 0.
2. Sign each `h` with P-256 privkey 1 as a **raw prehashed digest** (NOT through a
   Hash-then-sign API — e.g. python `ecdsa.SigningKey.sign_digest`, or
   `crypto.subtle` only if you can supply the digest directly). Normalize to low-S
   (`s = n - s` when `s > n/2`).
3. Paste `r`/`s` into `VEC_ACT_*` / `VEC_EXE_*` / `VEC_ROT_*` / `VEC_LEGACY_*`.
   `VEC_LEGACY_*` is signed over the V2-shaped payload on purpose — it must be
   REJECTED by every V3 verifier (`InvalidChallenge`).
4. Set `VEC_READY = true`, run `forge test`.

Gotcha log: WebCrypto/Node `crypto.sign("sha256", …)` hashes again internally and
produces signatures that fail `P256.verify` — always verify vectors mathematically
(`ecdsa.VerifyingKey.verify_digest`) before pasting.
