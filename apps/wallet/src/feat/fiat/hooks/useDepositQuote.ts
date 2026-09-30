import { useEffect, useState } from "react";
import type { DepositQuoteView, PeridotClient } from "@peridotvault/pid-sdk-js";
import { pickMethod, transferFeeOf } from "../../../shared/fiat";
import { MIN_NET_IDR } from "../utils/topup-amount";

// Server quote for the entered NET amount (moves no money), debounced until
// the user pauses on a valid amount. Method keeps the previous pick when the
// new quote still offers it.
export function useDepositQuote(
  peridot: PeridotClient,
  net: string,
  onError: (msg: string) => void,
) {
  const [quote, setQuote] = useState<DepositQuoteView | null>(null);
  const [method, setMethod] = useState<string | null>(null);

  // Quote the top-up (moves no money) once the user pauses on a valid amount.
  useEffect(() => {
    const trimmed = net.replace(/\D/g, "");
    if (!/^\d+$/.test(trimmed) || BigInt(trimmed) < MIN_NET_IDR) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      const n = BigInt(trimmed);
      peridot.fiat
        .quoteDeposit({ netAmountIdr: n.toString() })
        .then((q) => {
          if (cancelled) return;
          setQuote(q);
          setMethod((m) => pickMethod(m, q.paymentMethods));
        })
        .catch((e) => {
          if (!cancelled) onError(e instanceof Error ? e.message : String(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [net, peridot, onError]);

  const selected = quote?.paymentMethods.find((p) => p.key === method) ?? null;
  const noMethods = !!quote && quote.paymentMethods.length === 0;
  // One combined fee line: PeridotID (fee+PPN) + DOKU gateway (fee+PPN).
  const transferFee = quote ? transferFeeOf(quote) : "0";

  return { quote, setQuote, method, setMethod, selected, noMethods, transferFee };
}
