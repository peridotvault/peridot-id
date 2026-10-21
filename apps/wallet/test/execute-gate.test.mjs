// Unit tests for the unknown-target execute disclosure gate (ANT-262, AC8).
// Run: `node --test test/` from apps/wallet (Node >= 22, type stripping).
// N3: no test or helper emits raw call-data bytes — assertions below pin this.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  KNOWN_EXECUTE_PROGRAMS,
  assertExecuteGateAllows,
  describeExecuteCall,
  getExecuteGate,
  isKnownExecuteTarget,
  isWellFormedExecuteTarget,
} from "../src/feat/auth/utils/knownPrograms.ts";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

// Well-formed but unknown program address (32 zero bytes is valid base58).
const UNKNOWN_TARGET = "11111111111111111111111111111112";
const KNOWN_SYSTEM = "11111111111111111111111111111111";

describe("isKnownExecuteTarget", () => {
  it("recognises every pinned known program", () => {
    assert.equal(KNOWN_EXECUTE_PROGRAMS.size, 5);
    for (const target of KNOWN_EXECUTE_PROGRAMS) {
      assert.equal(isKnownExecuteTarget(target), true, target);
    }
  });

  it("returns false for well-formed unknown targets", () => {
    assert.equal(isWellFormedExecuteTarget(UNKNOWN_TARGET), true);
    assert.equal(isKnownExecuteTarget(UNKNOWN_TARGET), false);
  });

  it("fail-closed on malformed input (never true)", () => {
    for (const bad of ["", "not-an-address!!", "1111", "0".repeat(44), null, undefined, 42, {}, []]) {
      assert.equal(isKnownExecuteTarget(bad), false, JSON.stringify(bad));
    }
  });

  it("excludes Memo v1 until O1 is confirmed (discloses rather than silently signs)", () => {
    const memo = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
    assert.equal(isWellFormedExecuteTarget(memo), true);
    assert.equal(isKnownExecuteTarget(memo), false);
  });
});

describe("describeExecuteCall", () => {
  it("reports length, sha256, and writable counts", () => {
    const raw = new Uint8Array([9, 8, 7, 6, 5]);
    const d = describeExecuteCall({
      target: UNKNOWN_TARGET,
      metas: [
        { address: KNOWN_SYSTEM, writable: true, signer: false },
        { address: UNKNOWN_TARGET, writable: false, signer: true },
        { address: KNOWN_SYSTEM, writable: true, signer: true },
      ],
      data: b64url(raw),
    });
    assert.equal(d.target, UNKNOWN_TARGET);
    assert.equal(d.dataLen, 5);
    assert.equal(d.dataHashHex, sha256Hex(raw));
    assert.equal(d.metaCount, 3);
    assert.equal(d.writableCount, 2);
  });

  it("empty data shows 0 bytes + hash of empty input", () => {
    const d = describeExecuteCall({ target: UNKNOWN_TARGET, metas: [], data: "" });
    assert.equal(d.dataLen, 0);
    assert.equal(d.dataHashHex, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(d.metaCount, 0);
    assert.equal(d.writableCount, 0);
  });

  it("tolerates standard base64 with padding", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const std = Buffer.from(raw).toString("base64");
    const d = describeExecuteCall({ target: UNKNOWN_TARGET, metas: [], data: std });
    assert.equal(d.dataLen, 3);
    assert.equal(d.dataHashHex, sha256Hex(raw));
  });

  it("never emits raw call-data bytes (N3)", () => {
    const raw = new Uint8Array([222, 173, 190, 239]);
    const encoded = b64url(raw);
    const d = describeExecuteCall({ target: UNKNOWN_TARGET, metas: [], data: encoded });
    const dumped = JSON.stringify(d);
    assert.ok(!dumped.includes(encoded), "encoded call-data leaked into description");
    assert.ok(!dumped.includes("222"), "raw byte values leaked into description");
  });

  it("rejects malformed targets and metas", () => {
    assert.throws(() => describeExecuteCall({ target: "bogus!!", metas: [], data: "" }), /invalid execute target/);
    assert.throws(
      () => describeExecuteCall({ target: UNKNOWN_TARGET, metas: [{ address: "bogus", writable: true, signer: false }], data: "" }),
      /invalid meta address/,
    );
    assert.throws(() => describeExecuteCall({ target: UNKNOWN_TARGET, metas: [], data: "!!!not-base64!!!" }), /invalid data/);
  });
});

describe("getExecuteGate / assertExecuteGateAllows", () => {
  it("non-execute actions pass through untouched (AC1 shape)", () => {
    assert.deepEqual(getExecuteGate("withdraw", { amount: "1", to: "x" }), { kind: "not-execute" });
  });

  it("known targets stay silent (AC1)", () => {
    const gate = getExecuteGate("execute", { target: KNOWN_SYSTEM, metas: [], data: "" });
    assert.equal(gate.kind, "known");
    assertExecuteGateAllows("execute", { target: KNOWN_SYSTEM, metas: [], data: "" });
  });

  it("unknown targets disclose and require acknowledgement (AC3/AC7)", () => {
    const payload = { target: UNKNOWN_TARGET, metas: [], data: "" };
    const gate = getExecuteGate("execute", payload);
    assert.equal(gate.kind, "unknown");
    assert.throws(() => assertExecuteGateAllows("execute", payload), /acknowledgement/);
    assert.throws(() => assertExecuteGateAllows("execute", payload, { unknownAcknowledged: false }), /acknowledgement/);
    // No ceremony/call happens before acknowledgement: the throw above is the
    // enforcement point, placed before runAction in every call site.
    assertExecuteGateAllows("execute", payload, { unknownAcknowledged: true });
  });

  it("malformed targets block approval entirely (AC6)", () => {
    const gate = getExecuteGate("execute", { target: "bogus!!", metas: [], data: "" });
    assert.equal(gate.kind, "invalid");
    assert.throws(() => assertExecuteGateAllows("execute", { target: "bogus!!", metas: [], data: "" }, { unknownAcknowledged: true }));
  });

  it("malformed data/metas fail closed to invalid, never silent (AC5)", () => {
    const gate = getExecuteGate("execute", { target: UNKNOWN_TARGET, metas: "nope", data: "" });
    assert.equal(gate.kind, "invalid");
  });
});
