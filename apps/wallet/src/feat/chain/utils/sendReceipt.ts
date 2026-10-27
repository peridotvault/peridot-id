// Post-send receipt lines (ANT-748, parent ANT-743 pure 50% fee).
//
// The submit result carries the SETTLED legs (`networkFeeLamports` /
// `protocolFeeLamports`); the receipt renders them as separate line items
// plus the total — never a blended single "fee" line. All math is bigint on
// base-unit strings (spec NFR-5), so tiny chain fees (e.g. Monad-scale wei)
// render exactly instead of rounding to dust via floats.
//
// Pure and UI-free so node:test can cover it (see test/send-receipt.test.mjs);
// Send.tsx only interpolates the returned display strings.

import { formatFeeAmount } from "@peridotvault/pid-sdk-js";

function parseBaseUnits(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("send-receipt: fee legs must be base-unit integer strings");
  }
  return BigInt(value);
}

export interface SendReceiptInput {
  /** Settled network leg, base units (decimal string). */
  networkBaseUnits: string;
  /** Settled PeridotID service leg, base units (decimal string). */
  serviceBaseUnits: string;
  /** Base-unit decimals of the fee asset (SOL = 9). */
  decimals: number;
  /** Display symbol of the fee asset ("SOL"). */
  symbol: string;
}

export interface SendReceipt {
  networkFee: string;
  serviceFee: string;
  totalFee: string;
}

/** Format the settled legs as receipt lines. Throws on non-integer legs. */
export function formatSendReceipt(input: SendReceiptInput): SendReceipt {
  const network = parseBaseUnits(input.networkBaseUnits);
  const service = parseBaseUnits(input.serviceBaseUnits);
  const total = network + service;
  const fmt = (v: bigint) => formatFeeAmount(v.toString(), input.decimals, input.symbol);
  return {
    networkFee: fmt(network),
    serviceFee: fmt(service),
    totalFee: fmt(total),
  };
}
