import { deriveSmartAccountAddress, pidToSeed32 } from "./smart-account";

// Reference vectors generated with @solana/web3.js v1 findProgramAddressSync
// (seeds are sha256(pid)).
const PROGRAM_ID = "9LCZEdXdmLeEyU8Fik2721R28K4xWXTrVd76r4tczNZY";

describe("deriveSmartAccountAddress", () => {
  it("matches web3.js for a pid seed", () => {
    expect(deriveSmartAccountAddress("ifal@pid", PROGRAM_ID)).toEqual({
      address: "2XSyY7tMgbwfsHx7pkqYjwcpyoFLtFwzSophsFFtuaHj",
      bump: 255,
    });
  });

  it("seeds with sha256(lowercased pid)", () => {
    expect(pidToSeed32("ifal@pid").toString("hex")).toBe(
      "98bc15cccd4fd3a85b71e5b29b430d0cc461e7b5ebb7ac1b13428299ce52cfe7",
    );
    expect(pidToSeed32("ifal@pid").length).toBe(32);
    expect(pidToSeed32("IFAL@PID").equals(pidToSeed32("ifal@pid"))).toBe(true);
  });
});
