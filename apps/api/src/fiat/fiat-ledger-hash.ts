// Tamper-evident hash chain for the fiat ledger (pure — no Nest, no DB).
//
// Each posted entry commits to the one before it:
//   hash = sha256(canonical(entry fields) ‖ prevHash)
// so any edit, deletion, reorder, or insertion of a posted row breaks the
// chain from that point on (verifyChain reports the first bad entry). This is
// tamper-EVIDENT, not tamper-proof: an operator with full DB+code access could
// recompute the whole chain. To make it tamper-PROOF, anchor the head hash
// (`headHash`) outside the DB periodically (e.g. publish it on-chain) and
// compare later — the endpoint exposes it for exactly that.

import { createHash } from "node:crypto";

/** prevHash of the first entry in the chain. */
export const GENESIS_HASH = "0".repeat(64);

/** Immutable, value-bearing fields of one ledger entry, plus its chain link. */
export interface ChainableEntry {
  entryGroup: string;
  kind: string;
  pid: string;
  counterpartyPid: string | null;
  amountIdr: bigint | string;
  direction: string;
  idempotencyKey: string;
  parentRef: string | null;
  status: string;
  feePolicyVersion: number | null;
  prevHash: string;
}

/** Deterministic, field-ordered serialization fed to sha256. Uses "|" which
 *  cannot appear in any of the fields (kinds/pids/refs are URL-safe tokens). */
export function canonicalEntry(e: ChainableEntry): string {
  return [
    e.prevHash,
    e.entryGroup,
    e.kind,
    e.pid,
    e.counterpartyPid ?? "",
    e.amountIdr.toString(),
    e.direction,
    e.idempotencyKey,
    e.parentRef ?? "",
    e.status,
    e.feePolicyVersion == null ? "" : String(e.feePolicyVersion),
  ].join("|");
}

export function entryHash(e: ChainableEntry): string {
  return createHash("sha256").update(canonicalEntry(e)).digest("hex");
}

export interface VerifiableEntry extends Omit<ChainableEntry, "prevHash"> {
  prevHash: string | null;
  hash: string | null;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  /** Head hash of the verified prefix (the value to anchor externally). */
  headHash: string;
  firstBadIdempotencyKey: string | null;
  error: string | null;
}

/**
 * Fold the chain in `hashSeq` order (caller must pass rows already ordered).
 * A missing hash on any row is a hard failure (posted rows must be chained).
 */
export function verifyChain(entries: VerifiableEntry[]): ChainVerification {
  let prev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.hash) {
      return { ok: false, checked: i, headHash: prev, firstBadIdempotencyKey: e.idempotencyKey, error: `missing hash at seq ${i}` };
    }
    if (e.prevHash !== prev) {
      return { ok: false, checked: i, headHash: prev, firstBadIdempotencyKey: e.idempotencyKey, error: `prevHash mismatch at seq ${i}` };
    }
    const expected = entryHash({ ...e, prevHash: prev });
    if (expected !== e.hash) {
      return { ok: false, checked: i, headHash: prev, firstBadIdempotencyKey: e.idempotencyKey, error: `hash mismatch at seq ${i}` };
    }
    prev = e.hash;
  }
  return { ok: true, checked: entries.length, headHash: prev, firstBadIdempotencyKey: null, error: null };
}

// ponytail: self-check — `node dist/fiat/fiat-ledger-hash.js` fails loudly.
if (require.main === module) {
  const assert = require("node:assert");
  const base = {
    entryGroup: "IC-DP1", kind: "fiat_issue", pid: "a@pid", counterpartyPid: null,
    amountIdr: 100000n, direction: "in", idempotencyKey: "IC-DP1", parentRef: "DP1",
    status: "posted", feePolicyVersion: 4,
  };
  const h1 = entryHash({ ...base, prevHash: GENESIS_HASH });
  const e1 = { ...base, prevHash: GENESIS_HASH, hash: h1 };
  const e2 = { ...base, idempotencyKey: "IC-DP1-FEE", kind: "fiat_fee", direction: "out", amountIdr: 5000n, prevHash: h1, hash: entryHash({ ...base, kind: "fiat_fee", idempotencyKey: "IC-DP1-FEE", direction: "out", amountIdr: 5000n, prevHash: h1 }) };
  assert.strictEqual(verifyChain([e1, e2]).ok, true, "good chain verifies");
  assert.strictEqual(verifyChain([{ ...e1, amountIdr: 999n }]).ok, false, "tampered amount detected");
  assert.strictEqual(verifyChain([e1, { ...e2, prevHash: GENESIS_HASH }]).ok, false, "broken link detected");
  console.log("pid-api fiat-ledger-hash self-check OK");
}
