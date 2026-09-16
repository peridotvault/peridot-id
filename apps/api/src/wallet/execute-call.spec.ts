import {
  buildExecutePayloadV3,
  executeCallHash,
  EXECUTE_FLAG,
  IX,
  MAX_EXECUTE_DATA,
  MAX_EXECUTE_METAS,
  OP,
  serializeExecuteCall,
} from "@peridotvault/pid-core/dist/hash";

// serializeExecuteCall only calls `.toBytes()` on keys — keep @solana/web3.js
// (untransformable under Jest, see sponsored-withdraw.service.spec.ts) out.
// Module-level constants (`new PublicKey("…")`) must still construct.
jest.mock("@solana/web3.js", () => ({
  PublicKey: class {
    constructor(public readonly v: unknown = new Uint8Array(32)) {}
    toBytes(): Uint8Array {
      return this.v as Uint8Array;
    }
  },
}));

// Shared vector with `execute.rs::tests::execute_call_hash_and_payload_match_sdk_vector`
// (program) — pins SDK↔program byte parity for `call_hash` and the V3 execute payload.
const fakeKey = (fill: number) => ({ toBytes: () => new Uint8Array(32).fill(fill) }) as never;

const TARGET = fakeKey(0x07);
const METAS = [
  { address: fakeKey(0x11), writable: true, signer: false },
  { address: fakeKey(0x33), writable: false, signer: false },
  { address: fakeKey(0x44), writable: false, signer: true },
];
const DATA = new Uint8Array([3, 100, 0, 0, 0, 0, 0, 0, 0]);
const CALL_HEX =
  "0707070707070707070707070707070707070707070707070707070707070707" +
  "03" +
  "1111111111111111111111111111111111111111111111111111111111111111" +
  "01" +
  "3333333333333333333333333333333333333333333333333333333333333333" +
  "00" +
  "4444444444444444444444444444444444444444444444444444444444444444" +
  "02" +
  "0900" +
  "036400000000000000";
const CALL_HASH_HEX = "ec7e188859bc7d9d97be6408f5788c894d0f89fa989c7e8b08d033a6bf97a2fa";
const PAYLOAD_HEX = "0626bd30393ccfb8a0b694bdf653e78634b2a76839227e24c5e69da02dcc0341";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("execute call serialization (pid-core)", () => {
  it("exposes op-tag and discriminator 6", () => {
    expect(OP.execute).toBe(6);
    expect(IX.execute).toBe(6);
    expect(EXECUTE_FLAG).toEqual({ writable: 1, signer: 2 });
    expect(MAX_EXECUTE_METAS).toBe(64);
    expect(MAX_EXECUTE_DATA).toBe(10_240);
  });

  it("serializes the canonical call bytes the program hashes", () => {
    expect(hex(serializeExecuteCall(TARGET, METAS, DATA))).toBe(CALL_HEX);
  });

  it("computes the shared call_hash golden", async () => {
    expect(hex(await executeCallHash(TARGET, METAS, DATA))).toBe(CALL_HASH_HEX);
  });

  it("computes the shared V3 execute payload golden", async () => {
    const accountId32 = new Uint8Array(32).fill(0x22);
    const callHash = new Uint8Array(Buffer.from(CALL_HASH_HEX, "hex"));
    const payload = await buildExecutePayloadV3(accountId32, 7n, 1_700_000_000, 1, callHash);
    expect(hex(payload)).toBe(PAYLOAD_HEX);
  });

  it("rejects oversize calls fail-fast", () => {
    const many = Array.from({ length: 65 }, () => ({ address: fakeKey(1), writable: false, signer: false }));
    expect(() => serializeExecuteCall(TARGET, many, DATA)).toThrow(/too many/);
    expect(() => serializeExecuteCall(TARGET, METAS, new Uint8Array(10_241))).toThrow(/too large/);
  });

  it("rejects a malformed call hash in the payload builder", async () => {
    const accountId32 = new Uint8Array(32).fill(0x22);
    await expect(buildExecutePayloadV3(accountId32, 7n, 1_700_000_000, 1, new Uint8Array(31))).rejects.toThrow(
      /32 bytes/,
    );
  });
});
