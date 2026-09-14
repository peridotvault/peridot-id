import { pidToSeed32, sha256Sync, fromAscii, toHex } from "@peridotvault/pid-core/dist/bytes";

// The sync SHA-256 + pid seed live in pid-core (browser-neutral) — these vectors
// pin them against node:crypto so a broken hand-rolled hash can never ship.
describe("pidToSeed32 (pid-core)", () => {
  it("matches known SHA-256 vectors", () => {
    expect(toHex(sha256Sync(fromAscii("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(toHex(sha256Sync(fromAscii("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("seeds from the lowercased pid", () => {
    expect(toHex(pidToSeed32("ifal@pid"))).toBe(
      "98bc15cccd4fd3a85b71e5b29b430d0cc461e7b5ebb7ac1b13428299ce52cfe7",
    );
    expect(toHex(pidToSeed32("IFAL@PID"))).toBe(toHex(pidToSeed32("ifal@pid")));
  });

  it("rejects empty pids", () => {
    expect(() => pidToSeed32("  ")).toThrow("invalid pid");
  });
});
