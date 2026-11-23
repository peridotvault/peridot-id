
import { Info } from "../../../shared/components/icons";

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
    <div className="flex flex-col gap-1.5 border-t border-line py-3">
      <span className="mb-1.5 text-xs font-medium uppercase tracking-[0.6px] text-muted-foreground">Status</span>
      <div className="flex flex-row items-start gap-2">
        <Info size={16} className="text-muted-foreground" />
        <span className="font-sans text-sm leading-[19px] text-muted-foreground">
          {status === "ready"
            ? `Ready — your first send sets up the account.`
            : status === "inactivated"
              ? "Deposit SOL to your address above first."
              : status === "insufficient"
                ? `Need at least ${requiredSol.toFixed(4)} SOL to cover the first-send setup (you have ${balanceSol.toFixed(4)}).`
                : status === "activating"
                  ? "Setting up on-chain…"
                  : "Funds received — setup runs with your first send."}
        </span>
      </div>
    </div>
  );
}
