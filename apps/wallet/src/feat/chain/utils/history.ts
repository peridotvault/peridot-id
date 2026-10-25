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

export function meta(t: WalletTransaction): { label: string; icon: typeof ArrowUpRight; color: string } {
  switch (t.type) {
    case "DEPOSIT":
      return { label: "Receive", icon: ArrowDownLeft, color: theme.colors.success };
    case "WITHDRAW":
      return { label: "Send", icon: ArrowUpRight, color: theme.colors.foreground };
    case "ACTIVATION":
      return { label: "Activation", icon: Rocket, color: theme.colors.foreground };
    default:
      return { label: "Transaction", icon: RefreshCw, color: theme.colors.mutedForeground };
  }
}
