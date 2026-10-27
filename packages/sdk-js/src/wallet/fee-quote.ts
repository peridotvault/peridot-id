// PeridotID fee-transparency UI surface (ANT-557, spec ANT-544 FR-B/FR-E).
//
// Contract-first field names (ANT-544 §4.1 + Tyler ANT-555 backend):
//   { networkFee, platformFee, feePolicyVersion, totalFee, maxTotalFee, chainTime }
// plus the v2 envelope (quoteId, quotedAt, expiresAt, suggestedMaxTotalFee,
// chainMinBaseUnits, networkFeeAsset, protocolFeeBps). Legacy v1 aliases
// (networkFeeLamports, protocolFeeLamports, totalFeeLamports) are accepted by
// the normalizer so this UI works against pre-v2 backends too — the split is
// then derived as total − network and flagged, never silently blended.
//
// Amounts are base-unit integers encoded as decimal strings. No floats anywhere
// in fee paths (spec NFR-5).
//
// Failure-taxonomy codes are fixed by spec §3-E3; the user-facing copy lives
// here so wallet, popup review, and embed hosts render identical prompts.

import type { ChainEcho } from "./wallet-client.js";

/** Canonical v2 quote shape (Tyler ANT-555) with legacy v1 aliases. */
export interface FeeQuoteV2 {
  // --- canonical v2 (base units, decimal strings) ---
  networkFee?: string;
  platformFee?: string;
  feePolicyVersion?: number;
  totalFee?: string;
  /** Offered upper bound the user authorizes (defaults to totalFee at quote time). */
  maxTotalFee?: string;
  chainTime?: number;
  // --- v2 envelope ---
  quoteId?: string;
  quotedAt?: string;
  expiresAt?: string;
  suggestedMaxTotalFee?: string;
  chainMinBaseUnits?: string;
  networkFeeAsset?: string;
  protocolFeeBps?: number;
  treasury?: string;
  chain?: ChainEcho;
  // --- lazy first-action envelope (WS1 spec §7.1; WS2/WS3/WS-backend) ---
  // Present on v2 backends once they ship lazy activation; absent on older
  // backends. Never trust client hints: `required` is server-computed from
  // deployment state / the activation state machine.
  activation?: QuoteActivation;
  // --- legacy v1 aliases (pre-v2 backend) ---
  networkFeeLamports?: string;
  /** Legacy alias of the platform fee amount. */
  protocolFeeLamports?: string;
  platformFeeLamports?: string;
  totalFeeLamports?: string;
  maxTotalFeeLamports?: string;
}

/** Lazy first-action envelope (WS1 spec §7.1). Always present on v2 lazy
 * backends so clients never branch on version; `mode: "none"` +
 * `required: false` means the account is already active (identical to today).
 */
export interface QuoteActivation {
  /** Server-computed: this quote's intent triggers account creation. */
  required: boolean;
  /** The creation cost is inside totalFee (always true on v2). */
  includedInTotal: boolean;
  /** Network-fee share of the creation, base units (informational). */
  estimate: string;
  /** How the estimate was derived (e.g. gas table × gas price), if given. */
  estimateBasis?: string;
  /** Relayer composition for this intent. */
  mode: "evm-sequenced" | "svm-composite" | "svm-fallback-2step" | "none";
}

/** One fee quote with every UI field resolved. All amounts: base-unit decimal strings. */
export interface NormalizedFeeQuote {
  networkFee: string;
  platformFee: string;
  totalFee: string;
  /** The bound the approval screen must display verbatim (spec B5). */
  maxTotalFee: string;
  feePolicyVersion: number;
  chainTime: number;
  protocolFeeBps?: number;
  treasury?: string;
  quoteId?: string;
  quotedAtMs: number;
  /** Resolved expiry (expiresAt, else quotedAt + TTL, else chainTime + TTL). */
  expiresAtMs: number;
  networkFeeAsset?: string;
  suggestedMaxTotalFee?: string;
  chainMinBaseUnits?: string;
  chain?: ChainEcho;
  /** True when platformFee was derived as total − network (pre-v2 backend). */
  platformFeeDerived: boolean;
  /** True when maxTotalFee fell back to the quoted total (no offered bound). */
  maxTotalFeeDefaulted: boolean;
  /**
   * Lazy first-action envelope, passed through verbatim when the backend
   * sends a well-formed one (WS1 spec §7.1). Undefined on pre-lazy
   * backends — the UI treats that as "unknown, not required".
   */
  activation?: QuoteActivation;
  raw: unknown;
}

/** Quote TTL when the backend omits expiresAt (Tyler: QUOTE_TTL_SECS = 300). */
export const QUOTE_TTL_SECS = 300;
/** Authorization TTL cap (spec NFR-1: server + on-chain ≤ 600 s; client signs ~300 s). */
export const AUTHORIZATION_TTL_SECS = 600;

/** Solana base-unit decimals (lamports). Non-SOL assets pass their own decimals. */
export const SOLANA_DECIMALS = 9;

function parseBaseUnits(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function firstPresent(...values: Array<string | undefined>): string | undefined {
  for (const v of values) if (typeof v === "string" && v !== "") return v;
  return undefined;
}

/**
 * Validate the lazy first-action envelope (WS1 spec §7.1). Returns the
 * envelope when well-formed, else undefined — unknown shapes never reach
 * the UI as a half-parsed "required" flag.
 */
function parseQuoteActivation(value: unknown): QuoteActivation | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.required !== "boolean") return undefined;
  if (typeof v.includedInTotal !== "boolean") return undefined;
  if (typeof v.estimate !== "string" || !/^\d+$/.test(v.estimate)) return undefined;
  if (
    v.mode !== "evm-sequenced" &&
    v.mode !== "svm-composite" &&
    v.mode !== "svm-fallback-2step" &&
    v.mode !== "none"
  ) {
    return undefined;
  }
  if (v.estimateBasis !== undefined && typeof v.estimateBasis !== "string") return undefined;
  return {
    required: v.required,
    includedInTotal: v.includedInTotal,
    estimate: v.estimate,
    ...(typeof v.estimateBasis === "string" ? { estimateBasis: v.estimateBasis } : {}),
    mode: v.mode,
  };
}

function parseMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Normalize a v2 or legacy v1 quote into UI-ready fields. Throws on missing or
 * inconsistent amounts (fail closed — never render a blended or guessed total).
 */
export function normalizeFeeQuote(raw: FeeQuoteV2): NormalizedFeeQuote {
  const network = parseBaseUnits(firstPresent(raw.networkFee, raw.networkFeeLamports));
  const platform = parseBaseUnits(firstPresent(raw.platformFee, raw.protocolFeeLamports, raw.platformFeeLamports));
  const total = parseBaseUnits(firstPresent(raw.totalFee, raw.totalFeeLamports));
  const maxTotal = parseBaseUnits(firstPresent(raw.maxTotalFee, raw.maxTotalFeeLamports, raw.suggestedMaxTotalFee));
  const feePolicyVersion = raw.feePolicyVersion;
  const chainTime = raw.chainTime;

  if (network == null) throw new Error("fee-quote: missing networkFee");
  if (!Number.isInteger(feePolicyVersion) || (feePolicyVersion as number) < 1) {
    throw new Error("fee-quote: missing feePolicyVersion");
  }
  if (!Number.isFinite(chainTime)) throw new Error("fee-quote: missing chainTime");

  // Legacy backends omit platformFee — derive the split arithmetically so the
  // panel still shows separate lines (never a blended total only).
  let platformFee = platform;
  let platformFeeDerived = false;
  if (platformFee == null) {
    if (total == null) throw new Error("fee-quote: missing platformFee and totalFee");
    platformFee = total - network;
    if (platformFee < 0n) throw new Error("fee-quote: totalFee < networkFee");
    platformFeeDerived = true;
  }
  const totalFee = total ?? network + platformFee;
  if (total != null && total !== network + platformFee) {
    throw new Error("fee-quote: totalFee ≠ networkFee + platformFee");
  }
  // The offered bound defaults to the quoted total (backend v2 behavior); the
  // approval screen must still display it as the authorized max (spec E2).
  const maxTotalFee = maxTotal ?? totalFee;
  const maxTotalFeeDefaulted = maxTotal == null;
  if (maxTotalFee < totalFee) throw new Error("fee-quote: maxTotalFee < totalFee");

  const quotedAtMs = parseMs(raw.quotedAt) ?? Math.floor((chainTime as number) * 1000);
  const expiresAtMs = parseMs(raw.expiresAt) ?? quotedAtMs + QUOTE_TTL_SECS * 1000;

  // Lazy first-action envelope (WS1 §7.1): pass through only when
  // well-formed (boolean required + mode enum + numeric estimate string).
  // Anything else → undefined (pre-lazy backend), never a guessed shape.
  const activation = parseQuoteActivation(raw.activation);

  return {
    networkFee: network.toString(),
    platformFee: platformFee.toString(),
    totalFee: totalFee.toString(),
    maxTotalFee: maxTotalFee.toString(),
    feePolicyVersion: feePolicyVersion as number,
    chainTime: chainTime as number,
    protocolFeeBps: raw.protocolFeeBps,
    treasury: raw.treasury,
    quoteId: raw.quoteId,
    quotedAtMs,
    expiresAtMs,
    networkFeeAsset: raw.networkFeeAsset,
    suggestedMaxTotalFee: raw.suggestedMaxTotalFee,
    chainMinBaseUnits: raw.chainMinBaseUnits,
    chain: raw.chain,
    platformFeeDerived,
    maxTotalFeeDefaulted,
    activation,
    raw,
  };
}

/** Format base units as "0.000005 SOL" — integer math, trimmed, never abbreviated. */
export function formatFeeAmount(baseUnits: string, decimals: number, symbol: string): string {
  const value = parseBaseUnits(baseUnits);
  if (value == null) throw new Error("formatFeeAmount: amount must be a base-unit integer string");
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error("formatFeeAmount: bad decimals");
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const int = digits.slice(0, digits.length - decimals);
  let frac = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  const body = frac ? `${int}.${frac}` : int;
  return `${negative ? "-" : ""}${body} ${symbol}`;
}

/** Milliseconds until quote expiry (≤ 0 means expired). Pure — the countdown hook feeds nowMs. */
export function ttlRemainingMs(quote: NormalizedFeeQuote, nowMs: number): number {
  return quote.expiresAtMs - nowMs;
}

/** True when `balance` covers `value + totalFee` (all base-unit integer strings). */
export function coversBalance(balanceBaseUnits: string, valueBaseUnits: string, totalFeeBaseUnits: string): boolean | null {
  const b = parseBaseUnits(balanceBaseUnits);
  const v = parseBaseUnits(valueBaseUnits);
  const t = parseBaseUnits(totalFeeBaseUnits);
  if (b == null || v == null || t == null) return null;
  return b >= v + t;
}

/** Base-unit shortfall of `balance` against `value + totalFee` (never negative). */
export function shortfallBaseUnits(balanceBaseUnits: string, valueBaseUnits: string, totalFeeBaseUnits: string): string | null {
  const b = parseBaseUnits(balanceBaseUnits);
  const v = parseBaseUnits(valueBaseUnits);
  const t = parseBaseUnits(totalFeeBaseUnits);
  if (b == null || v == null || t == null) return null;
  const short = v + t - b;
  return (short > 0n ? short : 0n).toString();
}

// --- Failure taxonomy (spec §3-E3; codes fixed, copy owned by Frontend) ---

export type FeeFailureAction =
  | "re-sign"
  | "re-quote"
  | "top-up"
  | "fail-closed"
  | "cancelled"
  | "unknown";

export interface FeeFailure {
  code:
    | "STALE_NONCE"
    | "AUTHORIZATION_EXPIRED"
    | "FEE_DRIFT"
    | "MAX_TOTAL_EXCEEDED"
    | "INSUFFICIENT_FUNDS"
    | "POLICY_VIOLATION"
    | "APPROVAL_DENIED"
    | "UNKNOWN";
  /** One-line title for alerts/headings. */
  title: string;
  /** Full user-facing prompt. Shortfall amounts are interpolated by the caller via shortfallMessage. */
  body: string;
  action: FeeFailureAction;
}

/**
 * Map a submit/sign failure to the taxonomy prompt. Pure and order-sensitive:
 * specific classes first, unknown-version/policy fail-closed before drift.
 */
export function classifyFeeFailure(err: unknown): FeeFailure {
  const msg = err instanceof Error ? err.message : String(err ?? "");

  if (/approval denied|nothing was signed/i.test(msg)) {
    return {
      code: "APPROVAL_DENIED",
      title: "Approval cancelled",
      body: "Cancelled — nothing was signed and no fee was charged.",
      action: "cancelled",
    };
  }
  if (/stale|newer nonce/i.test(msg)) {
    return {
      code: "STALE_NONCE",
      title: "Approval is stale",
      body: "This approval is stale (another transaction landed first). Review the details and sign again — nothing was charged.",
      action: "re-sign",
    };
  }
  if (/authorization expired|expir/i.test(msg)) {
    return {
      code: "AUTHORIZATION_EXPIRED",
      title: "Approval expired",
      body: "Your approval expired before it could be used. Review the fresh quote and sign again — nothing was charged.",
      action: "re-sign",
    };
  }
  if (/insufficient/i.test(msg)) {
    return {
      code: "INSUFFICIENT_FUNDS",
      title: "Not enough balance",
      body: "Your balance doesn't cover this send plus the fee. Top up, then try again — nothing was charged.",
      action: "top-up",
    };
  }
  if (/unsupported fee policy|unknownfeepolicy|unknown fee policy/i.test(msg)) {
    return {
      code: "POLICY_VIOLATION",
      title: "Unsupported fee policy",
      body: "This quote uses a fee policy this wallet can't settle. Stopped for your safety — don't retry with the same details.",
      action: "fail-closed",
    };
  }
  if (/authorization lifetime|ttl|fee pol/i.test(msg)) {
    return {
      code: "POLICY_VIOLATION",
      title: "Authorization rejected",
      body: "This authorization violates the fee policy (TTL or version). Stopped for your safety — don't retry with the same details; start a fresh send instead.",
      action: "fail-closed",
    };
  }
  if (/exceeds your authorized maximum|feeexceedsmax/i.test(msg)) {
    return {
      code: "MAX_TOTAL_EXCEEDED",
      title: "Fee exceeded your max",
      body: "The fee rose above the maximum you authorized, so this transaction was stopped before anything was charged. Get a fresh quote to continue.",
      action: "re-quote",
    };
  }
  if (/moved — re-quote|re-quote|drift|120/i.test(msg)) {
    return {
      code: "FEE_DRIFT",
      title: "Fees moved",
      body: "Network fees moved while you were reviewing. Get a fresh quote — your new total will never exceed the maximum you approve.",
      action: "re-quote",
    };
  }
  return {
    code: "UNKNOWN",
    title: "Send failed",
    body: msg || "Something went wrong — nothing was charged. Try again.",
    action: "unknown",
  };
}

/** InsufficientFunds shortfall line: "Balance X vs needed Y (send Z + fee W) — short by S." */
export function shortfallMessage(input: {
  balanceBaseUnits: string;
  valueBaseUnits: string;
  totalFeeBaseUnits: string;
  decimals: number;
  symbol: string;
}): string {
  const short = shortfallBaseUnits(input.balanceBaseUnits, input.valueBaseUnits, input.totalFeeBaseUnits);
  if (short == null) return "Your balance doesn't cover this send plus the fee.";
  const fmt = (v: string) => formatFeeAmount(v, input.decimals, input.symbol);
  const needed = (BigInt(input.valueBaseUnits) + BigInt(input.totalFeeBaseUnits)).toString();
  return (
    `Balance ${fmt(input.balanceBaseUnits)} vs needed ${fmt(needed)} ` +
    `(send ${fmt(input.valueBaseUnits)} + fee ${fmt(input.totalFeeBaseUnits)}) — short by ${fmt(short)}.`
  );
}

// --- Pre-approval gate ---

/** Thrown when the user denies the fee panel — fail closed, nothing signed. */
export class FeeApprovalDeniedError extends Error {
  readonly code = "APPROVAL_DENIED";
  constructor() {
    super("Fee approval denied — nothing was signed");
    this.name = "FeeApprovalDeniedError";
  }
}

/**
 * Called with the exact quote the SDK is about to sign. Resolve true to
 * continue to the passkey ceremony, false to abort (throws
 * FeeApprovalDeniedError — nothing signed, nothing charged).
 */
export type FeeApprovalHandler = (quote: NormalizedFeeQuote) => Promise<boolean>;
