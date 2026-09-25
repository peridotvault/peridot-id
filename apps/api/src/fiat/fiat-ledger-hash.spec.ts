import { GENESIS_HASH, entryHash, verifyChain, type VerifiableEntry } from "./fiat-ledger-hash";

const base = {
  entryGroup: "IC-DP1", kind: "fiat_issue", pid: "a@pid", counterpartyPid: null,
  amountIdr: 100000n, direction: "in", idempotencyKey: "IC-DP1", parentRef: "DP1",
  status: "posted", feePolicyVersion: 4,
};

function chain(...rows: Array<Partial<typeof base>>): VerifiableEntry[] {
  let prev = GENESIS_HASH;
  return rows.map((r) => {
    const e = { ...base, ...r };
    const hash = entryHash({ ...e, prevHash: prev });
    const row: VerifiableEntry = { ...e, prevHash: prev, hash };
    prev = hash;
    return row;
  });
}

describe("fiat ledger hash chain", () => {
  it("verifies a valid chain and reports the head", () => {
    const rows = chain({}, { idempotencyKey: "IC-DP1-FEE", kind: "fiat_fee", direction: "out", amountIdr: 5000n });
    const v = verifyChain(rows);
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(2);
    expect(v.headHash).toBe(rows[1].hash);
    expect(v.error).toBeNull();
  });

  it("detects a tampered amount", () => {
    const rows = chain({});
    const v = verifyChain([{ ...rows[0], amountIdr: 999n }]);
    expect(v.ok).toBe(false);
    expect(v.firstBadIdempotencyKey).toBe("IC-DP1");
    expect(v.error).toMatch(/hash mismatch/);
  });

  it("detects a broken link", () => {
    const rows = chain({}, { idempotencyKey: "B", amountIdr: 1n });
    const v = verifyChain([rows[0], { ...rows[1], prevHash: GENESIS_HASH }]);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/prevHash mismatch/);
  });

  it("rejects a missing hash", () => {
    const rows = chain({});
    const v = verifyChain([{ ...rows[0], hash: null }]);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/missing hash/);
  });
});
