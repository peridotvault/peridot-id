import { Pressable } from "../../../shared/components/ui/Pressable";
import { ArrowDownLeft, ArrowUpRight, ChevronRight } from "../../../shared/components/icons";
import { theme, styles as s } from "../../../shared/styles/theme";
import type { FiatLedgerItem } from "../../../shared/data/fiat";
import { fmtIdr, ledgerStatusLabel } from "../../../shared/data/fiat";
import { ledgerLabel } from "../utils/history";
import { fmtDate } from "../../../shared/data/format";

export function LedgerRow({ item, onSelect }: { item: FiatLedgerItem; onSelect: (item: FiatLedgerItem) => void }) {
  const { tx } = item;
  const incoming = tx.direction === "in";
  const posted = tx.status === "posted";
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  const color = posted ? (incoming ? theme.colors.success : theme.colors.foreground) : theme.colors.mutedForeground;
  const tone = !posted ? "text-muted-foreground" : incoming ? "text-success" : "text-foreground";
  const amount = tx.amountIdr;
  // Only posted money gets a sign: pending/failed/cancelled moved nothing.
  const sign = posted ? (incoming ? "+" : "-") : "";
  return (
    <Pressable key={tx.id} style={s.card} onPress={() => onSelect(item)}>
      <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3">
        <div style={{ backgroundColor: color + "22" }} className="flex flex-col flex h-9 w-9 items-center justify-center rounded-full">
          <Icon size={16} className={tone} />
        </div>
        <div className="flex flex-col flex-1 gap-0.5">
          <span className="font-sans text-base font-semibold text-foreground">{ledgerLabel(item.kind, incoming)}</span>
          <span className="font-sans text-xs text-muted-foreground">{fmtDate(item.createdAt)} · {ledgerStatusLabel(tx.status)}</span>
        </div>
        <span className="font-mono text-sm font-medium text-foreground">{sign}{fmtIdr(amount)}</span>
        <ChevronRight size={16} className="text-muted-foreground" />
      </div>
    </Pressable>
  );
}
