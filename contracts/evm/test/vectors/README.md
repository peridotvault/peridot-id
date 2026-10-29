# V3 test vectors — RETIRED (ANT-863 B2)

The V3 fee paths are hard-closed on-chain (`V3Deprecated` on SVM discs 1/2/5/6
and the EVM `execute` / `deployAndInit` selectors), so no V3 signature vector
can settle anymore. The hardcoded `VEC_*` constants and `test_LogVector*`
helpers were removed from `PeridotAccount.t.sol`; all suites sign at runtime
(`vm.signP256` in forge, python `ecdsa` in the anvil loops).

The V3 payload layouts stay byte-frozen for decoder stability (discriminants
and selectors never shift — they decode, then reject). Do NOT regenerate
vectors for them: there is no live verifier left to pin.

- Rotation (`updateAuthority`, EVM) / keep-alive paths still verify under
  their unchanged domains; their tests sign at runtime too.
- Retired gotcha (kept for archaeology): WebCrypto/Node `crypto.sign("sha256", …)`
  hashes again internally and produces signatures that fail `P256.verify` —
  always verify vectors mathematically (`ecdsa.VerifyingKey.verify_digest`)
  before pasting. No longer applicable — nothing to paste into.
