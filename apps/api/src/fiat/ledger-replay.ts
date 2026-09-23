// Immutable double-entry PTS journal replay (pure — no Nest, no DB, no DOKU).
// Folds journal rows in replaySeq order into per-owner outstanding balances.
// This is the SAME function reconciliation and tests use: invariant 1 is
// `replay(journal) == live DOKU POINT balances`, exactly, always.
//
// Ownership model: PTS liabilities move between owners; fiat never follows.
// A row credits/debits exactly one owner. Treasury is a synthetic owner key
// (fee legs live under sender pids but belong to Treasury).
//
// Row kinds understood (anything else is an error — new kinds must register
// here before they can affect balances):
//   points_issue    credit pid (mint from SYSTEM_POINT — the backing boundary)
//   points_fee      credit TREASURY (sender pid on the row is incidental)
//   points_credit   credit pid (P2P recipient mirror, keyed by DOKU referenceNo)
//   transfer_internal debit pid gross — ONLY when counterparty.currency is
//                   POINT (legacy IDR-era rows are fiat intent, skipped)
//   points_clawback debit pid
//   points_redeem   debit pid, must carry extinguished=true (else error)
//   deposit/debit/debit_cancel/fee/legacy kinds: fiat intent or history —
//                   never PTS value, always skipped (counted, not errored)

export const TREASURY_KEY = "treasury";

export interface JournalRow {
  kind: string;
  pid: string;
  providerRef: string;
  providerStatus: string;
  amountIdr: bigint;
  direction?: string | null;
  entryGroup?: string | null;
  extinguished?: boolean | null;
  counterparty?: Record<string, unknown> | null;
  replaySeq?: bigint | number | null;
}

export interface ReplayResult {
  /** Outstanding per owner pid (treasury excluded — see `treasury`). */
  balances: Map<string, bigint>;
  treasury: bigint;
  /** Refs of non-settled points rows (in-flight, not counted). */
  inFlight: string[];
  /** Fiat-intent rows skipped by design (counted for audit). */
  skippedFiat: number;
  /** Anything structurally wrong — unknown kinds, direction mismatches,
   *  group imbalances, negative owners, unextinguished redeems. */
  errors: string[];
}

const POINTS_IN = new Set(["points_issue", "points_fee", "points_credit"]);
const POINTS_OUT = new Set(["points_clawback", "points_redeem", "transfer_internal"]);
const FIAT_INTENT = new Set([
  "deposit", "debit", "debit_cancel", "fee",
  "payout_bank", "payout_wallet", "transfer_fee",
]);

function seqOf(r: JournalRow): bigint {
  if (r.replaySeq == null) return 2n ** 62n; // unsequenced sorts last, stably
  return typeof r.replaySeq === "bigint" ? r.replaySeq : BigInt(r.replaySeq);
}

export function replayJournal(rows: JournalRow[]): ReplayResult {
  const balances = new Map<string, bigint>();
  let treasury = 0n;
  const inFlight: string[] = [];
  const errors: string[] = [];
  let skippedFiat = 0;
  const groups = new Map<string, { out: bigint; in: bigint }>();

  const credit = (owner: string, amount: bigint) => {
    balances.set(owner, (balances.get(owner) ?? 0n) + amount);
  };

  const ordered = [...rows].sort((a, b) => {
    const s = seqOf(a) < seqOf(b) ? -1 : seqOf(a) > seqOf(b) ? 1 : 0;
    return s !== 0 ? s : a.providerRef < b.providerRef ? -1 : 1;
  });

  for (const r of ordered) {
    if (r.providerStatus !== "settled") {
      if (POINTS_IN.has(r.kind) || POINTS_OUT.has(r.kind)) inFlight.push(r.providerRef);
      continue;
    }
    if (FIAT_INTENT.has(r.kind)) {
      skippedFiat++;
      continue;
    }
    // extinguished units were debited out of outstanding by the redeem row
    // itself (counted below). The flag exists so nothing may ever credit
    // them back: only points_redeem may carry it.
    if (r.extinguished && r.kind !== "points_redeem") {
      errors.push(`${r.providerRef}: extinguished flag on non-redeem kind ${r.kind}`);
      continue;
    }
    const group = r.entryGroup ?? null;
    const bump = (d: "out" | "in") => {
      if (!group) return;
      const g = groups.get(group) ?? { out: 0n, in: 0n };
      g[d] += r.amountIdr;
      groups.set(group, g);
    };
    const checkDirection = (expected: "in" | "out") => {
      if (r.direction != null && r.direction !== expected) {
        errors.push(`${r.providerRef}: direction ${r.direction} != ${expected} for kind ${r.kind}`);
      }
    };

    if (r.kind === "points_issue") {
      checkDirection("in");
      credit(r.pid, r.amountIdr);
      bump("in");
    } else if (r.kind === "points_fee") {
      checkDirection("out"); // debited from the sender's ownership…
      treasury += r.amountIdr; // …and credited to Treasury
      bump("in");
    } else if (r.kind === "points_credit") {
      checkDirection("in");
      credit(r.pid, r.amountIdr);
      bump("in");
    } else if (r.kind === "transfer_internal") {
      // Legacy IDR-era transfers are fiat intent, NOT PTS movements.
      if ((r.counterparty as Record<string, unknown> | null)?.currency !== "POINT") {
        skippedFiat++;
        continue;
      }
      checkDirection("out");
      credit(r.pid, -r.amountIdr);
      bump("out");
    } else if (r.kind === "points_clawback") {
      checkDirection("out");
      credit(r.pid, -r.amountIdr);
    } else if (r.kind === "points_redeem") {
      if (!r.extinguished) {
        errors.push(`${r.providerRef}: redeem without extinguished=true — burned units must be marked`);
        continue;
      }
      checkDirection("out");
      credit(r.pid, -r.amountIdr);
    } else {
      errors.push(`${r.providerRef}: unknown journal kind ${r.kind}`);
    }
  }

  // Double-entry conservation: every transfer group must balance
  // (sender-out gross == recipient-in net + treasury-in fee).
  for (const [group, g] of groups) {
    if (g.out !== 0n && g.out !== g.in) {
      errors.push(`group ${group} imbalanced: out ${g.out} != in ${g.in}`);
    }
  }

  for (const [owner, bal] of balances) {
    if (bal < 0n) errors.push(`owner ${owner} negative outstanding ${bal}`);
  }
  if (treasury < 0n) errors.push(`treasury negative outstanding ${treasury}`);

  return { balances, treasury, inFlight, skippedFiat, errors };
}

/** Total redeemable outstanding across all owners (treasury included). */
export function totalOutstanding(replayed: ReplayResult): bigint {
  let total = replayed.treasury;
  for (const bal of replayed.balances.values()) total += bal;
  return total;
}
