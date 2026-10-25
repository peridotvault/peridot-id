import type { WalletTransaction } from "@peridotvault/pid-types";
import { ArrowDownLeft, ArrowUpRight, RefreshCw, Rocket } from "../../../shared/components/icons";
import { theme } from "../../../shared/styles/theme";

const LAMPORTS_PER_SOL = 1e9;

export function fmtAmount(t: WalletTransaction): string {
  if (t.amount == null) return "";
  const asset = t.asset === "SOL" ? "SOL" : t.asset;
  const value = Number(t.amount) / (t.asset === "SOL" ? LAMPORTS_PER_SOL : 1e6);
  const sign = t.direction === "in" ? "+" : t.direction === "out" ? "-" : "";
  return `${sign}${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${asset}`;
}

// Row identity per tx type: new types extend the table, not the branch.
const TX_META: Record<string, { label: string; icon: typeof ArrowUpRight; color: string }> = {
  DEPOSIT: { label: "Receive", icon: ArrowDownLeft, color: theme.colors.success },
  WITHDRAW: { label: "Send", icon: ArrowUpRight, color: theme.colors.foreground },
  ACTIVATION: { label: "Activation", icon: Rocket, color: theme.colors.foreground },
};

const DEFAULT_META = { label: "Transaction", icon: RefreshCw, color: theme.colors.mutedForeground };

export function meta(t: WalletTransaction): { label: string; icon: typeof ArrowUpRight; color: string } {
  return TX_META[t.type ?? ""] ?? DEFAULT_META;
}
