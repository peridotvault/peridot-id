import type { WalletTransaction } from "@peridotvault/pid-types";
import { ChevronRight } from "../../../shared/components/icons";
import { ListRow, RowTile } from "../../../shared/components/ui/ListRow";
import { fmtAmount, meta } from "../utils/txFormat";
import { fmtDate } from "../../../shared/data/format";

export function ChainRow({ tx: t, onSelect }: { tx: WalletTransaction; onSelect: (tx: WalletTransaction) => void }) {
  const m = meta(t);
  const Icon = m.icon;
  return (
    <ListRow key={t.id} onPress={() => onSelect(t)}>
      <RowTile tint={m.color}>
        <Icon size={16} color={m.color} />
      </RowTile>
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="font-sans text-base font-semibold text-foreground">{m.label}</span>
        <span className="font-sans text-xs text-muted-foreground">{fmtDate(t.createdAt)} · {t.status}</span>
      </div>
      {t.amount != null && <span className="font-mono text-sm font-medium text-foreground">{fmtAmount(t)}</span>}
      <ChevronRight size={16} className="text-muted-foreground" />
    </ListRow>
  );
}
