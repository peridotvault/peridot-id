import { pidsInCreateData } from "./pid-ref";

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
