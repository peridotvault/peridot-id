// V3 EVM calldata + payload invariants.
//
// These tests pin the exact ABI encoding the backend submits to
// `PeridotFactory.deployAndInit` and the exact V3 authorization payload the
// passkey signs, independent of the adapter implementation:
// - selector matches the canonical V3 factory signature;
// - every static field round-trips at its ABI slot;
// - dynamic assertion bytes round-trip via offsets;
// - the V3 execute payload equals an independent keccak recomputation (spec §3.1),
//   starts with DOMAIN_V3 + op-tag, and differs from older shapes.
import { EvmAdapter, keccak256, fromAscii, toHex } from "@peridotvault/pid-evm";

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const IMPL = "0x0000000000000000000000000000000000000001";

function adapter() {
  const rpc = { getBalance: async () => 0n, getCode: async () => "0x", chainId: async () => 97, gasPrice: async () => 0n, blockTimestamp: async () => 0, call: async () => "0x" };
  return new EvmAdapter(rpc as never, FACTORY, IMPL);
}

const u256 = (hex: string) => BigInt("0x" + hex.replace(/^0x/, ""));
const word = (i: number, data: string) => "0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64);

describe("V3 EVM deployAndInit calldata", () => {
  it("encodes the canonical selector and round-trips every field", () => {
    const a = adapter();
    const salt = "0x" + "07".padStart(64, "0");
    const x = new Uint8Array(32).fill(1);
    const y = new Uint8Array(32).fill(2);
    const rpId = new Uint8Array(32).fill(3);
    const authData = new Uint8Array(37).fill(4);
    const clientData = new Uint8Array(64).fill(5);
    const r = new Uint8Array(32).fill(6);
    const s = new Uint8Array(32).fill(7);
    const data = a.buildDeployAndInitDataV3({
      salt, x, y, rpIdHash: rpId, feePolicyVersion: 1,
      deadline: 1_000_300, networkFee: 500_000n, authenticatorData: authData,
      clientDataJSON: clientData, r, s,
    });

    const expectedSel = "0x" + toHex(
      keccak256(fromAscii("deployAndInit(bytes32,bytes32,bytes32,bytes32,uint16,uint64,uint256,bytes,bytes,bytes32,bytes32)")).subarray(0, 4),
    );
    expect(data.slice(0, 10)).toBe(expectedSel);
    const body = data.slice(10);
    expect(word(0, "0x" + body)).toBe(salt.toLowerCase());
    expect(u256(word(1, "0x" + body))).toBe(BigInt("0x" + "01".repeat(32))); // x = 0x01…01
    expect(u256(word(2, "0x" + body))).toBe(BigInt("0x" + "02".repeat(32))); // y = 0x02…02
    expect(u256(word(3, "0x" + body))).toBe(BigInt("0x" + "03".repeat(32))); // rpIdHash
    expect(u256(word(4, "0x" + body))).toBe(1n); // policy
    expect(u256(word(5, "0x" + body))).toBe(1_000_300n); // deadline
    expect(u256(word(6, "0x" + body))).toBe(500_000n); // networkFee (attested, not signed)
    // Static tail follows the Solidity parameter order: dynamic offsets FIRST,
    // then r/s. (A builder placing r/s before the offsets produces calldata the
    // ABI decoder rejects with an empty revert — regression-anchored here.)
    const off0 = Number(u256(word(7, "0x" + body)));
    const off1 = Number(u256(word(8, "0x" + body)));
    expect(u256(word(9, "0x" + body))).toBe(BigInt("0x" + Buffer.from(r).toString("hex")));
    expect(u256(word(10, "0x" + body))).toBe(BigInt("0x" + Buffer.from(s).toString("hex")));
    // Dynamic offsets point past the 11 static slots.
    expect(off0).toBe(11 * 32);
    expect(off1).toBeGreaterThan(off0);
    const readBytes = (off: number) => {
      const len = Number(u256("0x" + body.slice(off * 2, off * 2 + 64)));
      return body.slice(off * 2 + 64, off * 2 + 64 + len * 2);
    };
    expect(readBytes(off0)).toBe(Buffer.from(authData).toString("hex"));
    expect(readBytes(off1)).toBe(Buffer.from(clientData).toString("hex"));
  });

  it("builds a V3 execute payload matching the spec recomputation", () => {
    const a = adapter();
    const account = "0x15b4F164718FAC7cfDA7B60687acA4173C99aafc";
    const to = "0x0000000000000000000000000000000000001234";
    const dataHash = keccak256(new Uint8Array(0));
    const got = Buffer.from(a.buildExecutePayloadV3({
      chainId: 97, account, nonce: 0, to, value: 1000, dataHash,
      deadline: 1_000_300, feePolicyVersion: 1,
    })).toString("hex");
    const ube = (v: bigint, n: number) => v.toString(16).padStart(n * 2, "0");
    const parts = Buffer.concat([
      Buffer.from("PID|EVM|SMART_ACCOUNT|v3", "ascii"),
      Buffer.from([0x01]),
      Buffer.from(ube(97n, 32), "hex"),
      Buffer.from(account.slice(2).toLowerCase(), "hex"),
      Buffer.from(ube(0n, 8), "hex"),
      Buffer.from(to.slice(2), "hex"),
      Buffer.from(ube(1000n, 32), "hex"),
      Buffer.from(dataHash),
      Buffer.from(ube(1_000_300n, 8), "hex"),
      Buffer.from(ube(1n, 2), "hex"),
    ]);
    expect(got).toBe(Buffer.from(keccak256(parts)).toString("hex"));
  });

  it("encodes V3 execute calldata with offsets before r/s (ABI order)", () => {
    const a = adapter();
    const to = "0x0000000000000000000000000000000000001234";
    const callData = new Uint8Array([0xaa, 0xbb]);
    const authData = new Uint8Array(37).fill(4);
    const clientData = new Uint8Array(64).fill(5);
    const r = new Uint8Array(32).fill(6);
    const s = new Uint8Array(32).fill(7);
    const data = a.buildExecuteDataV3({
      to, value: 1000n, data: callData, deadline: 1_000_300, feePolicyVersion: 1,
      networkFee: 500_000n, authenticatorData: authData, clientDataJSON: clientData, r, s,
    });
    const expectedSel = "0x" + toHex(
      keccak256(fromAscii("execute(address,uint256,bytes,uint64,uint16,uint256,bytes,bytes,bytes32,bytes32)")).subarray(0, 4),
    );
    expect(data.slice(0, 10)).toBe(expectedSel);
    const body = data.slice(10);
    // Static slots: to(0) value(1) dataOff(2) deadline(3) policy(4) fee(5) authOff(6) clientOff(7) r(8) s(9).
    expect(u256(word(3, "0x" + body))).toBe(1_000_300n);
    expect(u256(word(4, "0x" + body))).toBe(1n);
    expect(u256(word(5, "0x" + body))).toBe(500_000n);
    const offData = Number(u256(word(2, "0x" + body)));
    const offAuth = Number(u256(word(6, "0x" + body)));
    const offClient = Number(u256(word(7, "0x" + body)));
    expect(offData).toBe(10 * 32);
    expect(offAuth).toBe(offData + 32 + 32); // 2-byte calldata → 32B region
    expect(offClient).toBe(offAuth + 32 + 64); // 37B authData → 64B region
    expect(u256(word(8, "0x" + body))).toBe(BigInt("0x" + Buffer.from(r).toString("hex")));
    expect(u256(word(9, "0x" + body))).toBe(BigInt("0x" + Buffer.from(s).toString("hex")));
    const readBytes = (off: number) => {
      const len = Number(u256("0x" + body.slice(off * 2, off * 2 + 64)));
      return body.slice(off * 2 + 64, off * 2 + 64 + len * 2);
    };
    expect(readBytes(offData)).toBe(Buffer.from(callData).toString("hex"));
    expect(readBytes(offAuth)).toBe(Buffer.from(authData).toString("hex"));
    expect(readBytes(offClient)).toBe(Buffer.from(clientData).toString("hex"));
  });

  it("separates V3 from older payloads and binds the factory on activation", () => {
    const a = adapter();
    const salt = "0x" + "07".padStart(64, "0");
    const x = new Uint8Array(32).fill(1);
    const y = new Uint8Array(32).fill(2);
    const rpId = new Uint8Array(32).fill(3);
    const v3 = Buffer.from(a.buildActivatePayloadV3({
      salt, x, y, rpIdHash: rpId, feePolicyVersion: 1,
      deadline: 1_000_300, chainId: 97, factory: FACTORY,
    })).toString("hex");
    // Older domains must never appear in a V3 payload.
    expect(Buffer.from(v3, "hex").toString("ascii")).not.toContain("SMART_ACCOUNT|v2");
    expect(Buffer.from(v3, "hex").toString("ascii")).not.toContain("SMART_ACCOUNT|v1");
    // Factory address is bound (last 20 bytes of the preimage hash input differ per factory).
    const other = Buffer.from(a.buildActivatePayloadV3({
      salt, x, y, rpIdHash: rpId, feePolicyVersion: 1,
      deadline: 1_000_300, chainId: 97, factory: "0x1111111111111111111111111111111111111111",
    })).toString("hex");
    expect(other).not.toBe(v3);
  });
});
