import { pidsInCreateData, pidsInWriteArgs, SHADOWABLE_PID_MODELS } from "./pid-ref";

describe("pidsInCreateData", () => {
  it("reads a single pid", () => {
    expect(pidsInCreateData({ pid: "ifal@pid", amount: 1 })).toEqual(["ifal@pid"]);
  });

  it("reads createMany rows and dedupes", () => {
    expect(pidsInCreateData([{ pid: "a@pid" }, { pid: "a@pid" }, { pid: "b@pid" }, { nope: 1 }])).toEqual([
      "a@pid",
      "b@pid",
    ]);
  });

  it("ignores absent, empty, and non-string pids", () => {
    expect(pidsInCreateData(undefined)).toEqual([]);
    expect(pidsInCreateData({})).toEqual([]);
    expect(pidsInCreateData({ pid: "" })).toEqual([]);
    expect(pidsInCreateData({ pid: 7 })).toEqual([]);
    expect(pidsInCreateData(null)).toEqual([]);
  });
});

describe("pidsInWriteArgs", () => {
  it("reads create and data payloads", () => {
    expect(pidsInWriteArgs({ data: { pid: "a@pid" } })).toEqual(["a@pid"]);
    expect(pidsInWriteArgs({ create: { pid: "b@pid" } })).toEqual(["b@pid"]);
  });

  it("reads the where pid of an upsert (no data/create on every model)", () => {
    expect(pidsInWriteArgs({ where: { pid: "c@pid" }, update: {} })).toEqual(["c@pid"]);
  });

  it("never shadows identity-owned tables", () => {
    for (const model of ["Profile", "IdentityCredential", "Device", "ClaimTicket"]) {
      expect(SHADOWABLE_PID_MODELS.has(model)).toBe(false);
    }
    // login events are written on every sign-in and key on identity.pid
    expect(SHADOWABLE_PID_MODELS.has("LoginEvent")).toBe(true);
  });
});
