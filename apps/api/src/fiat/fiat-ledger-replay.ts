// Immutable double-entry internal-credit journal replay (pure — no Nest,
// no DB). Folds `posted` rows in replaySeq order into per-owner balances.
// Modeled on fiat/ledger-replay.ts so the two rails stay comparable for the
// migration back to the DOKU Unified Ledger (docs/FUTURE_UNIFIED_LEDGER.md).
//
// Row kinds (anything else is an error — new kinds must register here):
//   fiat_issue        credit pid (mint from a corroborated Checkout deposit)
//   fiat_fee          credit synthetic TREASURY (sender pid on the row is incidental)
//   fiat_app_fee      credit pid (per-app fee → the app's own account)
//   fiat_transfer_in  credit pid (send recipient leg)
//   fiat_transfer_out debit pid gross (send sender leg)
//   fiat_adjust       signed correction leg (direction decides the side)

export const FIAT_LEDGER_TREASURY_KEY = "treasury";

export interface FiatLedgerRow {
  kind: string;
  pid: string;
  idempotencyKey: string;
  entryGroup?: string | null;
  amountIdr: bigint;
  direction?: string | null;
  status: string;
  replaySeq?: bigint | number | null;
}

export interface FiatLedgerReplayResult {
  balances: Map<string, bigint>;
  treasury: bigint;
  inFlight: string[];
  errors: string[];
}

const CREDIT_IN = new Set(["fiat_issue", "fiat_transfer_in", "fiat_app_fee"]);
const CREDIT_OUT = new Set(["fiat_transfer_out"]);

function seqOf(r: FiatLedgerRow): bigint {
  if (r.replaySeq == null) return 2n ** 62n; // unsequenced sorts last, stably
  return typeof r.replaySeq === "bigint" ? r.replaySeq : BigInt(r.replaySeq);
}

export function replayFiatLedger(rows: FiatLedgerRow[]): FiatLedgerReplayResult {
  const balances = new Map<string, bigint>();
  let treasury = 0n;
  const inFlight: string[] = [];
  const errors: string[] = [];
  const groups = new Map<string, { out: bigint; in: bigint }>();

  const credit = (owner: string, amount: bigint) => {
    balances.set(owner, (balances.get(owner) ?? 0n) + amount);
  };

  const ordered = [...rows].sort((a, b) => {
    const s = seqOf(a) < seqOf(b) ? -1 : seqOf(a) > seqOf(b) ? 1 : 0;
    return s !== 0 ? s : a.idempotencyKey < b.idempotencyKey ? -1 : 1;
  });

  for (const r of ordered) {
    if (r.status !== "posted") {
      if (CREDIT_IN.has(r.kind) || CREDIT_OUT.has(r.kind) || r.kind === "fiat_fee" || r.kind === "fiat_adjust") {
        inFlight.push(r.idempotencyKey);
      }
      continue;
    }
    if (r.amountIdr <= 0n) {
      errors.push(`${r.idempotencyKey}: non-positive amount ${r.amountIdr}`);
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
        errors.push(`${r.idempotencyKey}: direction ${r.direction} != ${expected} for kind ${r.kind}`);
      }
    };

    if (r.kind === "fiat_issue") {
      checkDirection("in");
      credit(r.pid, r.amountIdr);
      bump("in");
    } else if (r.kind === "fiat_fee") {
      checkDirection("out"); // debited from the sender's ownership…
      treasury += r.amountIdr; // …and credited to Treasury
      bump("in");
    } else if (r.kind === "fiat_app_fee") {
      checkDirection("in"); // per-app fee credited to the app's own account
      credit(r.pid, r.amountIdr);
      bump("in");
    } else if (r.kind === "fiat_transfer_in") {
      checkDirection("in");
      credit(r.pid, r.amountIdr);
      bump("in");
    } else if (r.kind === "fiat_transfer_out") {
      checkDirection("out");
      credit(r.pid, -r.amountIdr);
      bump("out");
    } else if (r.kind === "fiat_adjust") {
      // Signed correction: direction decides the side (in = credit, out = debit).
      if (r.direction === "in") {
        credit(r.pid, r.amountIdr);
        bump("in");
      } else if (r.direction === "out") {
        credit(r.pid, -r.amountIdr);
        bump("out");
      } else {
        errors.push(`${r.idempotencyKey}: adjust without direction in|out`);
      }
    } else {
      errors.push(`${r.idempotencyKey}: unknown journal kind ${r.kind}`);
    }
  }

  // Double-entry conservation: every movement group must balance
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

  return { balances, treasury, inFlight, errors };
}

/** Total outstanding across all owners (treasury included). */
export function totalFiatOutstanding(replayed: FiatLedgerReplayResult): bigint {
  let total = replayed.treasury;
  for (const bal of replayed.balances.values()) total += bal;
  return total;
}
