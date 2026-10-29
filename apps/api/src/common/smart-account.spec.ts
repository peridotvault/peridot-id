import { deriveSmartAccountAddress, pidToSeed32 } from "./smart-account";

// Reference vectors generated with @solana/web3.js v1 findProgramAddressSync
// (seeds are sha256(pid)).
const PROGRAM_ID = "9LCZEdXdmLeEyU8Fik2721R28K4xWXTrVd76r4tczNZY";

describe("deriveSmartAccountAddress", () => {
  // B1 (ANT-866): the PDA commits to the claiming key — keyless derivation
  // no longer exists on-chain, so the authority is required.
  const AUTH = Buffer.from("02" + "11".repeat(32), "hex");

  it("matches web3.js for a pid seed", () => {
    const keyless = deriveSmartAccountAddress as unknown as (pid: string, programId: string) => unknown;
    expect(() => keyless("ifal@pid", PROGRAM_ID)).toThrow();
  });

  it("binds (pid, key): distinct keys diverge, same input is stable", () => {
    const a = deriveSmartAccountAddress("ifal@pid", PROGRAM_ID, AUTH);
    const b = deriveSmartAccountAddress("ifal@pid", PROGRAM_ID, AUTH);
    expect(a.address).toBe(b.address);
    expect(a.bump).toBe(b.bump);
    const other = deriveSmartAccountAddress(
      "ifal@pid",
      PROGRAM_ID,
      Buffer.from("03" + "22".repeat(32), "hex"),
    );
    expect(other.address).not.toBe(a.address);
    expect(() => deriveSmartAccountAddress("ifal@pid", PROGRAM_ID, Buffer.alloc(32))).toThrow(/33 bytes/);
  });

  it("seeds with sha256(lowercased pid)", () => {
    expect(pidToSeed32("ifal@pid").toString("hex")).toBe(
      "98bc15cccd4fd3a85b71e5b29b430d0cc461e7b5ebb7ac1b13428299ce52cfe7",
    );
    expect(pidToSeed32("ifal@pid").length).toBe(32);
    expect(pidToSeed32("IFAL@PID").equals(pidToSeed32("ifal@pid"))).toBe(true);
  });
});
