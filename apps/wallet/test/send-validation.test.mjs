// ANT-346 M8: Send destination validation — base58 32-byte check before
// withdraw. Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSolanaAddress, sendDestinationError } from "../src/feat/chain/utils/solana-address.ts";

const SYSTEM = "11111111111111111111111111111111"; // 32 zero bytes
const PAYER = "kgERWXbLfq6MHcWLd86a5dpmSvM86QhQrQjL2gGPbnD"; // 32 random bytes

describe("isSolanaAddress", () => {
  it("accepts well-formed addresses", () => {
    assert.equal(isSolanaAddress(SYSTEM), true);
    assert.equal(isSolanaAddress(PAYER), true);
  });

  it("rejects empty / short / bad-alphabet input", () => {
    assert.equal(isSolanaAddress(""), false);
    assert.equal(isSolanaAddress("   "), false);
    assert.equal(isSolanaAddress("4uQeVj5tqViQh7y8CXe"), false); // too short
    assert.equal(isSolanaAddress("0OIl4uQeVj5tqViQh7y8CXe9zG3xKpWsT2m"), false); // 0/O/I/l illegal
  });

  it("rejects valid base58 of the wrong length", () => {
    assert.equal(isSolanaAddress("111111111111111111111111111111111"), false); // 33 bytes
    assert.equal(isSolanaAddress("11111111111111111111111111111"), false); // <32 bytes
  });

  it("rejects non-strings", () => {
    assert.equal(isSolanaAddress(null), false);
    assert.equal(isSolanaAddress(undefined), false);
    assert.equal(isSolanaAddress(42), false);
  });
});

describe("sendDestinationError", () => {
  it("returns null for sendable destinations", () => {
    assert.equal(sendDestinationError(SYSTEM), null);
    assert.equal(sendDestinationError(`  ${PAYER}  `), null); // pasted with whitespace
  });

  it("returns copy for empty / malformed destinations", () => {
    assert.match(sendDestinationError(""), /destination/i);
    assert.match(sendDestinationError("not-an-address"), /Solana address/);
  });
});
