import { Pressable } from "../../../shared/components/ui/Pressable";
import { Check } from "../../../shared/components/icons";
import type { DepositTarget } from "../utils/depositTargets";

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
          <div key={t.key} className={`flex flex-col mt-4 rounded-lg border bg-surface p-3 ${alert ? "border-danger" : "border-border"}`}>
            <div className="mb-2 flex flex-row items-baseline justify-between">
              <span className="font-sans text-base font-semibold">{t.label}</span>
              <p className="text-xs text-muted-foreground">{t.sublabel}</p>
            </div>
            {alert && <span className="mb-2 font-sans text-xs font-medium text-danger">Top up here for your first send</span>}
            <Pressable
              onPress={() => (isSol ? onOpen(t) : onCopy(t.key, t.address))}
            >
              <div className="flex w-full items-center justify-between gap-2 border-t border-line py-3">
                <span className="min-w-0 break-all select-text font-mono text-sm text-foreground">{t.address}</span>
                {copiedKey === t.key && <Check size={16} className="shrink-0 text-success" />}
              </div>
            </Pressable>
            {copiedKey === t.key && <span className="text-center font-sans text-sm text-success">Copied to clipboard</span>}
          </div>
        );
      })}
    </>
  );
}
