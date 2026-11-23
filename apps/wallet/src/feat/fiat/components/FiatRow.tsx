import { ArrowDownLeft, ArrowUpRight, ChevronRight } from "../../../shared/components/icons";
import { ListRow, RowTile } from "../../../shared/components/ui/ListRow";
import { theme } from "../../../shared/styles/theme";
import type { FiatItem } from "../../../shared/data/fiat";
import { fiatStatusLabel, fmtIdr } from "../../../shared/data/fiat";
import { fiatLabel } from "../utils/history";
import { fmtDate } from "../../../shared/data/format";

export function FiatRow({ item, onSelect }: { item: FiatItem; onSelect: (item: FiatItem) => void }) {
  const incoming = item.kind === "deposit";
  const { tx } = item;
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  const color = tx.providerStatus === "settled" || tx.providerStatus === "success" ? theme.colors.success : theme.colors.foreground;
  const tinted = color === theme.colors.success;
  // Only live money gets a sign: failed/cancelled/expired moved nothing.
  const live = ["settled", "success", "processing", "created"].includes(tx.providerStatus);
  const sign = live ? (incoming ? "+" : "-") : "";
  // Fee rows move the fee, not the parent gross — show what actually moved.
  // Headline rule everywhere: show NET (what the user gets), fall back to
  // gross while unsettled.
  const moved = item.kind === "fee" ? (tx.feeIdr ?? tx.grossIdr) : (tx.netIdr ?? tx.grossIdr);
  return (
    <ListRow key={tx.id} onPress={() => onSelect(item)}>
      <RowTile tint={color}>
        <Icon size={16} className={tinted ? "text-success" : "text-foreground"} />
      </RowTile>
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="font-sans text-base font-semibold text-foreground">{fiatLabel(item.kind)}</span>
        <span className="font-sans text-xs text-muted-foreground">{fmtDate(item.createdAt)} · {fiatStatusLabel(item.kind, tx.providerStatus)}</span>
      </div>
      <span className="font-mono text-sm font-medium text-foreground">{sign}{fmtIdr(moved)}</span>
      <ChevronRight size={16} className="text-muted-foreground" />
    </ListRow>
  );
}
