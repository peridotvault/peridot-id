import { Pressable } from "../../../shared/components/Pressable";
import { Copy } from "../../../shared/icons";
import { styles as s } from "../../../shared/theme";
import { flatten } from "../../../shared/styles";

export function DepositAddressCard({
  address,
  balanceSol,
  requiredSol,
  copied,
  onCopy,
}: {
  address: string | null;
  balanceSol: number;
  requiredSol: number;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div style={s.card} className="flex flex-col">
      <span style={flatten([s.label, { marginBottom: 6 }])}>Your deposit address</span>
      <span className="font-sans text-sm leading-[19px] text-muted-foreground">
        Send SOL to this address to fund your wallet and cover activation. The cost
        currently requires about {requiredSol.toFixed(4)} SOL.
      </span>
      <Pressable onPress={onCopy} accessibilityLabel="Copy deposit address">
        <div style={{ flexDirection: "row" }} className="flex flex-col mt-1 w-full items-center justify-between gap-2 border border-border bg-muted p-3">
          <span style={s.mono} className="select-text flex-1">
            {address ? `${address.slice(0, 8)}…${address.slice(-8)}` : "—"}
          </span>
          {copied ? (
            <span className="font-sans text-xs text-success">Copied</span>
          ) : (
            <Copy size={14} className="text-muted-foreground" />
          )}
        </div>
      </Pressable>
      <p style={s.hint}>
        Balance: {balanceSol.toFixed(4)} SOL{balanceSol < requiredSol ? ` — top up to at least ${requiredSol.toFixed(4)} SOL` : ""}.
      </p>
    </div>
  );
}
