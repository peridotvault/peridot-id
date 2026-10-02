import { useCallback, useState } from "react";
import type {
  CheckoutDepositView,
  DepositQuoteView,
  FiatTransferInquiryView,
  PeridotClient,
} from "@peridotvault/pid-sdk-js";
import { fmtIdr, pickMethod, selectedTransferFee } from "../../../shared/fiat";

// Server-quoted fiat state for popup approvals. Summaries are built from
// THESE (DOKU-side truth), never from opener-supplied amounts — a malicious
// opener can't display one amount while submitting another.
export function useFiatPrepare(peridot: PeridotClient) {
  const [inquiry, setInquiry] = useState<FiatTransferInquiryView | null>(null);
  // Top-up checkout: a server quote (moves no money) shown before approval; the
  // intent is created only on Approve, with the chosen method.
  const [checkout, setCheckout] = useState<DepositQuoteView | null>(null);
  const [checkoutReq, setCheckoutReq] = useState<{ netAmountIdr: string; clientId?: string } | null>(null);
  const [checkoutMethod, setCheckoutMethod] = useState<string | null>(null);
  const selectedQuote = checkout?.paymentMethods.find((m) => m.key === checkoutMethod) ?? null;
  // One combined fee line for the SELECTED method: PeridotID (fee+PPN) + DOKU
  // gateway (fee+PPN). The quote was fetched method-less, so derive it from the
  // selected method's total — keeps the fee line reconciled with the total.
  const transferFee = checkout ? selectedTransferFee(checkout, selectedQuote) : "0";
  // Live summary so the "Requested action" total tracks the method selection.
  const checkoutSummary = checkout
    ? `Top up ${fmtIdr(checkout.netIdr)} — total payment ${fmtIdr(selectedQuote?.totalIdr ?? checkout.totalIdr)}. You complete payment on the DOKU page after approval.`
    : null;

  /** Server-side prepare: inquiry/quote now, returns the verified summary text. */
  const prepare = useCallback(async (action: string, p: Record<string, unknown>): Promise<string> => {
    if (action === "fiat-transfer") {
      const amountIdr = typeof p.amountIdr === "string" ? p.amountIdr : "";
      const beneficiaryPid = typeof p.beneficiaryPid === "string" ? p.beneficiaryPid : "";
      if (!/^\d+$/.test(amountIdr) || !beneficiaryPid) throw new Error("Transfer request is malformed.");
      const inq = await peridot.fiat.transferInquiry({
        amountIdr,
        beneficiaryPid,
        ...(typeof p.remark === "string" ? { remark: p.remark } : {}),
        ...(typeof p.clientId === "string" ? { clientId: p.clientId } : {}),
        // Escrow legs (campaign funding/refund) carry no app fee.
        ...(p.operation === "escrow" ? { operation: "escrow" as const } : {}),
      });
      // Tamper guard: the quote must match what the opener asked for.
      if (inq.grossIdr !== amountIdr) throw new Error("Quote mismatch — request rejected.");
      if (!inq.netIdr || !inq.feeIdr) {
        throw new Error("Quote incomplete — request rejected.");
      }
      setInquiry(inq);
      return `Send ${fmtIdr(inq.netIdr)} to ${beneficiaryPid} · fee ${fmtIdr(inq.feeIdr)} · total debited ${fmtIdr(inq.grossIdr)}`;
    }
    if (action === "fiat-checkout") {
      const netAmountIdr = typeof p.netAmountIdr === "string" ? p.netAmountIdr : "";
      if (!/^\d+$/.test(netAmountIdr)) throw new Error("Top-up request is malformed.");
      const clientId = typeof p.clientId === "string" ? p.clientId : undefined;
      const quote = await peridot.fiat.quoteDeposit({ netAmountIdr, ...(clientId ? { clientId } : {}) });
      if (quote.netIdr !== netAmountIdr || !quote.totalIdr || !quote.peridotFeeIdr) {
        throw new Error("Quote mismatch — request rejected.");
      }
      if (!quote.paymentMethods?.length) {
        throw new Error("No payment methods available for this top-up right now.");
      }
      setCheckout(quote);
      setCheckoutReq({ netAmountIdr, ...(clientId ? { clientId } : {}) });
      setCheckoutMethod((m) => pickMethod(m, quote.paymentMethods));
      // Total lives in the live `checkoutSummary` (tracks the selected method).
      return `Top up ${fmtIdr(quote.netIdr)}. You complete payment on the DOKU page after approval.`;
    }
    throw new Error(`Not a fiat action "${action}"`);
  }, [peridot]);

  /** Fiat actions run through prepared server state, not raw opener payload. */
  const execute = useCallback(async (action: string): Promise<{ result: unknown; checkoutUrl: string | null }> => {
    if (action === "fiat-checkout") {
      // Create the intent now, with the approved method, then navigate.
      if (!checkoutReq) throw new Error("Verified top-up missing — request rejected.");
      const created: CheckoutDepositView = await peridot.fiat.checkoutDeposit(
        checkoutReq.netAmountIdr,
        checkoutReq.clientId,
        checkoutMethod ?? undefined,
      );
      return { result: created, checkoutUrl: created.paymentUrl ?? null };
    }
    if (action === "fiat-transfer") {
      if (!inquiry) throw new Error("Verified transfer missing — request rejected.");
      return { result: await peridot.fiat.transferConfirm(inquiry.id), checkoutUrl: null };
    }
    throw new Error(`Not a fiat action "${action}"`);
  }, [peridot, inquiry, checkoutReq, checkoutMethod]);

  const cancelInquiry = useCallback(() => {
    if (inquiry) void peridot.fiat.cancelTransaction(inquiry.id).catch(() => undefined);
  }, [peridot, inquiry]);

  return {
    inquiry,
    checkout,
    checkoutMethod,
    setCheckoutMethod,
    selectedQuote,
    transferFee,
    checkoutSummary,
    prepare,
    execute,
    cancelInquiry,
  };
}
