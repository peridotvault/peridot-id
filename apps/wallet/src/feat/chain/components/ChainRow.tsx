import { Pressable } from "../../../shared/components/ui/Pressable";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { ChevronRight } from "../../../shared/components/icons";
import { fmtAmount, meta } from "../utils/txFormat";
import { fmtDate } from "../../../shared/data/format";

export function ChainRow({ tx: t, onSelect }: { tx: WalletTransaction; onSelect: (tx: WalletTransaction) => void }) {
  const m = meta(t);
  const Icon = m.icon;
  return (
    <Pressable key={t.id} className="border-t border-line px-6 py-3" onPress={() => onSelect(t)}>
      <div className="flex flex-row items-center gap-3">
        <div style={{ backgroundColor: m.color + "22" }} className="flex h-9 w-9 items-center justify-center rounded-md">
          <Icon size={16} color={m.color} />
        </div>
        <div className="flex flex-col flex-1 gap-0.5">
          <span className="font-sans text-base font-semibold text-foreground">{m.label}</span>
          <span className="font-sans text-xs text-muted-foreground">{fmtDate(t.createdAt)} · {t.status}</span>
        </div>
        {t.amount != null && <span className="font-mono text-sm font-medium text-foreground">{fmtAmount(t)}</span>}
        <ChevronRight size={16} className="text-muted-foreground" />
      </div>
    </Pressable>
  );
}
