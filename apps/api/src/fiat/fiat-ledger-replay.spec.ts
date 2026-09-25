import { replayFiatLedger, totalFiatOutstanding } from "./fiat-ledger-replay";

const row = (over: Record<string, unknown>) => ({
  kind: "fiat_issue",
  pid: "ifal@pid",
  idempotencyKey: "K",
  entryGroup: null,
  amountIdr: 100_000n,
  direction: "in",
  status: "posted",
  replaySeq: 1n,
  ...over,
});

describe("replayFiatLedger", () => {
  it("credits issues and routes fees to treasury", () => {
    const r = replayFiatLedger([
      row({ idempotencyKey: "IC-DP1", entryGroup: "IC-DP1", amountIdr: 95_000n }),
      row({ kind: "fiat_fee", idempotencyKey: "IC-DP1-FEE", entryGroup: "IC-DP1", amountIdr: 5_000n, direction: "out" }),
    ]);
    expect(r.balances.get("ifal@pid")).toBe(95_000n);
    expect(r.treasury).toBe(5_000n);
    expect(r.errors).toEqual([]);
    expect(totalFiatOutstanding(r)).toBe(100_000n);
  });

  it("folds a balanced send group (G == N + F)", () => {
    const r = replayFiatLedger([
      row({ kind: "fiat_transfer_out", pid: "dev@pid", idempotencyKey: "CT1", entryGroup: "CT1", amountIdr: 500_000n, direction: "out", replaySeq: 1n }),
      row({ kind: "fiat_transfer_in", pid: "live2dev@pid", idempotencyKey: "CT1-IN", entryGroup: "CT1", amountIdr: 475_000n, replaySeq: 2n }),
      row({ kind: "fiat_fee", pid: "dev@pid", idempotencyKey: "CT1-FEE", entryGroup: "CT1", amountIdr: 25_000n, direction: "out", replaySeq: 3n }),
    ]);
    expect(r.balances.get("dev@pid")).toBe(-500_000n + 0n); // negative owner flagged below, value still folds
    expect(r.balances.get("live2dev@pid")).toBe(475_000n);
    expect(r.errors.some((e) => e.includes("negative"))).toBe(true);
  });

  it("ignores non-posted rows as inFlight and errors unknown kinds", () => {
    const r = replayFiatLedger([
      row({ idempotencyKey: "CT2", status: "created" }),
      row({ kind: "mystery", idempotencyKey: "X", status: "posted" }),
    ]);
    expect(r.inFlight).toEqual(["CT2"]);
    expect(r.errors.some((e) => e.includes("unknown journal kind"))).toBe(true);
  });

  it("errors imbalanced groups", () => {
    const r = replayFiatLedger([
      row({ kind: "fiat_transfer_out", idempotencyKey: "CT3", entryGroup: "CT3", amountIdr: 100n, direction: "out" }),
      row({ kind: "fiat_transfer_in", pid: "b@pid", idempotencyKey: "CT3-IN", entryGroup: "CT3", amountIdr: 90n }),
    ]);
    expect(r.errors.some((e) => e.includes("imbalanced"))).toBe(true);
  });
});
