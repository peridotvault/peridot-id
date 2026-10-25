import { Pressable } from "../../../shared/components/Pressable";
import { ArrowDownLeft, ArrowUpRight, ChevronRight } from "../../../shared/icons";
import { theme, styles as s } from "../../../shared/theme";
import type { FiatItem } from "../../../shared/fiat";
import { fiatStatusLabel, fmtIdr } from "../../../shared/fiat";
import { fiatLabel, fmtDate } from "../utils/feed";

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
    <Pressable key={tx.id} style={s.card} onPress={() => onSelect(item)}>
      <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3">
        <div style={{ backgroundColor: color + "22" }} className="flex flex-col flex h-9 w-9 items-center justify-center rounded-full">
          <Icon size={16} className={tinted ? "text-success" : "text-foreground"} />
        </div>
        <div className="flex flex-col flex-1 gap-0.5">
          <span className="font-sans text-base font-semibold text-foreground">{fiatLabel(item.kind)}</span>
          <span className="font-sans text-xs text-muted-foreground">{fmtDate(item.createdAt)} · {fiatStatusLabel(item.kind, tx.providerStatus)}</span>
        </div>
        <span className="font-mono text-sm font-medium text-foreground">{sign}{fmtIdr(moved)}</span>
        <ChevronRight size={16} className="text-muted-foreground" />
      </div>
    </Pressable>
  );
}
