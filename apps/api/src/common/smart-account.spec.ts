import { deriveSmartAccountAddress, uuidTo32 } from "./smart-account";

// Reference vectors generated with @solana/web3.js v1 findProgramAddressSync
// (task 002's shared vectors — packages/solana revalidates in task 006).
const PROGRAM_ID = "9LCZEdXdmLeEyU8Fik2721R28K4xWXTrVd76r4tczNZY";

describe("deriveSmartAccountAddress", () => {
  it("matches web3.js for the primary vector (bump 255)", () => {
    const accountId = "b3f1e6a9-2c4d-4f8b-9a3e-8d7c5b2a1f9e";
    expect(deriveSmartAccountAddress(accountId, PROGRAM_ID)).toEqual({
      address: "2NLJ3iEMJoL6SyvvUeVcHLrKiqw4L5xEwUSnn4wnpiDq",
      bump: 255,
    });
  });

  it("matches web3.js when the first bump is on-curve (bump 253)", () => {
    const accountId = "11111111-1111-4111-8111-111111110000";
    expect(deriveSmartAccountAddress(accountId, PROGRAM_ID)).toEqual({
      address: "DnL2KV2uuMY8JDxprkBebXuGbB6cLSQgr5UYaeMpndog",
      bump: 253,
    });
  });

  it("zero-pads the uuid to 32 bytes", () => {
    const accountId = "b3f1e6a9-2c4d-4f8b-9a3e-8d7c5b2a1f9e";
    expect(uuidTo32(accountId).toString("hex")).toBe(
      "00000000000000000000000000000000b3f1e6a92c4d4f8b9a3e8d7c5b2a1f9e",
    );
    expect(uuidTo32(accountId).length).toBe(32);
  });
});