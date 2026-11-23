import { FiatAccount } from "./FiatAccount";
import { FiatDetail } from "./FiatDetail";
import { FiatLedgerDetail } from "./FiatLedgerDetail";
import { FiatTransfer } from "./FiatTransfer";
import { Topup } from "./Topup";

export const fiatPages = {
  topup: Topup,
  "fiat-account": FiatAccount,
  "fiat-detail": FiatDetail,
  "fiat-ledger-detail": FiatLedgerDetail,
  "fiat-transfer": FiatTransfer,
};
