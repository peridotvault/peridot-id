import { Pressable } from "../../../shared/components/ui/Pressable";
import { Check } from "../../../shared/components/icons";
import { styles as s } from "../../../shared/styles/theme";
import type { DepositTarget } from "../utils/deposit-targets";

export function DepositCardList({
  targets,
  solAlert,
  copiedKey,
  onOpen,
  onCopy,
}: {
  targets: DepositTarget[];
  /** True while the SOL account is not yet active (red alert styling). */
  solAlert: boolean;
  copiedKey: string | null;
  onOpen: (t: DepositTarget) => void;
  onCopy: (key: string, address: string) => void;
}) {
  return (
    <>
      {targets.map((t) => {
        const isSol = t.key.startsWith("solana-");
        const alert = isSol && solAlert;
        return (
          <div key={t.key} className={`flex flex-col mt-4 border bg-surface p-3 ${alert ? "border-danger" : "border-border"}`}>
            <div style={{ flexDirection: "row" }} className="flex flex-col mb-2 items-baseline justify-between">
              <span className="font-sans text-base font-semibold">{t.label}</span>
              <p style={s.hint}>{t.sublabel}</p>
            </div>
            {alert && <span className="mb-2 font-sans text-xs font-medium text-danger">Top up here to activate</span>}
            <Pressable
              onPress={() => (isSol ? onOpen(t) : onCopy(t.key, t.address))}
            >
              <div style={{ flexDirection: "row" }} className="flex flex-col w-full items-center justify-between gap-2 border border-border bg-background p-3">
                <span style={s.mono} className="select-text">{t.address}</span>
                {copiedKey === t.key && <Check size={16} className="text-success" />}
              </div>
            </Pressable>
            {copiedKey === t.key && <span className="text-center font-sans text-sm text-success">Copied to clipboard</span>}
          </div>
        );
      })}
    </>
  );
}
