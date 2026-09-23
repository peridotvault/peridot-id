// Pure replay tests — hand-built chains, no mocks, no DOKU. These encode the
// accounting contract: replay(journal) must reconstruct exact ownership
// through arbitrary transfer chains.

import { replayJournal, totalOutstanding, TREASURY_KEY, type JournalRow } from "./ledger-replay";

let seq = 0n;
function row(partial: Partial<JournalRow> & { kind: string; pid: string; providerRef: string; amountIdr: bigint }): JournalRow {
  seq += 1n;
  return { providerStatus: "settled", direction: null, entryGroup: null, extinguished: false, counterparty: null, replaySeq: seq, ...partial };
}
beforeEach(() => { seq = 0n; });

const ISSUE = (pid: string, ref: string, amount: bigint, group: string) =>
  row({ kind: "points_issue", pid, providerRef: ref, amountIdr: amount, direction: "in", entryGroup: group });
const FEE = (pid: string, ref: string, amount: bigint, group: string) =>
  row({ kind: "points_fee", pid, providerRef: ref, amountIdr: amount, direction: "out", entryGroup: group, counterparty: { destination: "treasury" } });
const XFER = (pid: string, ref: string, gross: bigint) =>
  row({ kind: "transfer_internal", pid, providerRef: ref, amountIdr: gross, direction: "out", entryGroup: ref, counterparty: { currency: "POINT" } });
const MIRROR = (pid: string, ref: string, net: bigint, group: string) =>
  row({ kind: "points_credit", pid, providerRef: ref, amountIdr: net, direction: "in", entryGroup: group });

describe("replayJournal", () => {
  it("Alice→Bob: ownership moves, conservation holds", () => {
    // Alice deposits net 100k (fee 5k): issue 100k + treasury 5k.
    // Alice sends gross 40k to Bob: out 40k, Bob in 38k, treasury in 2k.
    const rows = [
      ISSUE("alice@pid", "DP1-PTS", 100_000n, "DP1"),
      FEE("alice@pid", "DP1-PTS-FEE", 5_000n, "DP1"),
      XFER("alice@pid", "ST1", 40_000n),
      MIRROR("bob@pid", "DOKU-R1", 38_000n, "ST1"),
      FEE("alice@pid", "ST1-PTFEE", 2_000n, "ST1"),
    ];
    const r = replayJournal(rows);
    expect(r.errors).toEqual([]);
    expect(r.balances.get("alice@pid")).toBe(60_000n);
    expect(r.balances.get("bob@pid")).toBe(38_000n);
    expect(r.treasury).toBe(7_000n);
    expect(totalOutstanding(r)).toBe(105_000n); // == fiat paid in
  });

  it("Alice→Bob→Charlie→David chain reconstructs every owner", () => {
    const rows = [
      ISSUE("alice@pid", "DP1-PTS", 100_000n, "DP1"),
      FEE("alice@pid", "DP1-PTS-FEE", 5_000n, "DP1"),
      // Alice → Bob, gross 40k
      XFER("alice@pid", "ST1", 40_000n),
      MIRROR("bob@pid", "DOKU-R1", 38_000n, "ST1"),
      FEE("alice@pid", "ST1-PTFEE", 2_000n, "ST1"),
      // Bob → Charlie, gross 20k (partial)
      XFER("bob@pid", "ST2", 20_000n),
      MIRROR("charlie@pid", "DOKU-R2", 19_000n, "ST2"),
      FEE("bob@pid", "ST2-PTFEE", 1_000n, "ST2"),
      // Charlie → David, gross 19k (everything Charlie has)
      XFER("charlie@pid", "ST3", 19_000n),
      MIRROR("david@pid", "DOKU-R3", 18_050n, "ST3"),
      FEE("charlie@pid", "ST3-PTFEE", 950n, "ST3"),
    ];
    const r = replayJournal(rows);
    expect(r.errors).toEqual([]);
    expect(r.balances.get("alice@pid")).toBe(60_000n);
    expect(r.balances.get("bob@pid")).toBe(18_000n);
    expect(r.balances.get("charlie@pid")).toBe(0n);
    expect(r.balances.get("david@pid")).toBe(18_050n);
    expect(r.treasury).toBe(5_000n + 2_000n + 1_000n + 950n);
    // Conservation across the whole chain: outstanding == minted.
    expect(totalOutstanding(r)).toBe(105_000n);
  });

  it("missing recipient mirror is a group imbalance (the historical gap)", () => {
    const rows = [
      ISSUE("alice@pid", "DP1-PTS", 100_000n, "DP1"),
      FEE("alice@pid", "DP1-PTS-FEE", 5_000n, "DP1"),
      XFER("alice@pid", "ST1", 40_000n), // mirror never written (old code)
      FEE("alice@pid", "ST1-PTFEE", 2_000n, "ST1"),
    ];
    const r = replayJournal(rows);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/ST1.*imbalanced/);
    expect(r.balances.get("alice@pid")).toBe(60_000n);
    expect(r.balances.has("bob@pid")).toBe(false); // ownership unanswerable
  });

  it("clawback debits the owner; redemption burn leaves outstanding forever", () => {
    const rows = [
      ISSUE("alice@pid", "DP1-PTS", 100_000n, "DP1"),
      FEE("alice@pid", "DP1-PTS-FEE", 5_000n, "DP1"),
      row({ kind: "points_clawback", pid: "alice@pid", providerRef: "DP1-CLAWBACK-1", amountIdr: 10_000n, direction: "out" }),
      row({ kind: "points_redeem", pid: "alice@pid", providerRef: "DP1-REDEEM-1", amountIdr: 20_000n, direction: "out", extinguished: true }),
    ];
    const r = replayJournal(rows);
    expect(r.errors).toEqual([]);
    expect(r.balances.get("alice@pid")).toBe(70_000n);
    expect(totalOutstanding(r)).toBe(75_000n); // 105k - 10k claw - 20k burned
  });

  it("unsettled rows are in-flight, fiat rows skipped, unknown kinds error", () => {
    const rows = [
      ISSUE("alice@pid", "DP1-PTS", 100_000n, "DP1"),
      row({ kind: "points_issue", pid: "alice@pid", providerRef: "DP2-PTS", amountIdr: 50_000n, providerStatus: "processing" }),
      row({ kind: "deposit", pid: "alice@pid", providerRef: "DP9", amountIdr: 999_999n }),
      row({ kind: "mystery", pid: "alice@pid", providerRef: "X1", amountIdr: 1n }),
    ];
    const r = replayJournal(rows);
    expect(r.balances.get("alice@pid")).toBe(100_000n);
    expect(r.inFlight).toEqual(["DP2-PTS"]);
    expect(r.skippedFiat).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/unknown journal kind mystery/);
  });

  it("legacy IDR-era transfers are fiat intent, never PTS", () => {
    const rows = [
      row({ kind: "transfer_internal", pid: "alice@pid", providerRef: "ST-OLD", amountIdr: 50_000n }),
      ISSUE("alice@pid", "DP1-PTS", 100_000n, "DP1"),
    ];
    const r = replayJournal(rows);
    expect(r.errors).toEqual([]);
    expect(r.balances.get("alice@pid")).toBe(100_000n);
    expect(r.skippedFiat).toBe(1);
  });

  it("negative owner balance is an error (journal gap, never a real state)", () => {
    const rows = [XFER("alice@pid", "ST1", 40_000n)];
    const r = replayJournal(rows);
    expect(r.errors.some((e) => e.includes("negative outstanding"))).toBe(true);
  });

  it("TREASURY_KEY is stable for ownership queries", () => {
    expect(TREASURY_KEY).toBe("treasury");
  });
});
