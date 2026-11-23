import { Pressable } from "../../../shared/components/ui/Pressable";
import { Copy } from "../../../shared/components/icons";
import { Label } from "../../../shared/components/ui/Label";

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
    <div className="flex flex-col gap-1.5 border-t border-line py-3">
      <Label className="mb-1.5">Your deposit address</Label>
      <span className="font-sans text-sm leading-[19px] text-muted-foreground">
        Send SOL to this address to fund your wallet and cover the first-send setup. The cost
        currently requires about {requiredSol.toFixed(4)} SOL.
      </span>
      <Pressable onPress={onCopy} accessibilityLabel="Copy deposit address">
        <div className="flex w-full items-center justify-between gap-2 border-t border-line py-3">
          <span className="select-text flex-1 font-mono text-sm text-foreground">
            {address ? `${address.slice(0, 8)}…${address.slice(-8)}` : "—"}
          </span>
          {copied ? (
            <span className="font-sans text-xs text-success">Copied</span>
          ) : (
            <Copy size={14} className="text-muted-foreground" />
          )}
        </div>
      </Pressable>
      <p className="text-xs text-muted-foreground">
        Balance: {balanceSol.toFixed(4)} SOL{balanceSol < requiredSol ? ` — top up to at least ${requiredSol.toFixed(4)} SOL` : ""}.
      </p>
    </div>
  );
}
