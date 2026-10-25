
import { Info } from "../../../shared/components/icons";
import { styles as s } from "../../../shared/styles/theme";
import { flatten } from "../../../shared/styles/stylesheet";

export function ActivationStatusCard({
  status,
  requiredSol,
  balanceSol,
}: {
  status: string | undefined;
  requiredSol: number;
  balanceSol: number;
}) {
  return (
    <div style={s.card} className="flex flex-col">
      <span style={flatten([s.label, { marginBottom: 6 }])}>Status</span>
      <div style={{ flexDirection: "row" }} className="flex flex-col items-start gap-2">
        <Info size={16} className="text-muted-foreground" />
        <span className="font-sans text-sm leading-[19px] text-muted-foreground">
          {status === "ready"
            ? `Ready to activate.`
            : status === "inactivated"
              ? "Deposit SOL to your address above first."
              : status === "insufficient"
                ? `Need at least ${requiredSol.toFixed(4)} SOL to cover activation (you have ${balanceSol.toFixed(4)}).`
                : status === "activating"
                  ? "Activating on-chain…"
                  : "Funds received — activation is checked shortly."}
        </span>
      </div>
    </div>
  );
}
