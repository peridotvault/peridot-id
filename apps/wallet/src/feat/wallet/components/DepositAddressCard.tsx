import { Text, TouchableOpacity, View } from "../../../shared/primitives";
import { Copy } from "../../../shared/icons";
import { styles as s } from "../../../shared/theme";

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
    <View style={s.card}>
      <Text style={[s.label, { marginBottom: 6 }]}>Your deposit address</Text>
      <Text className="font-sans text-[13px] leading-[19px] text-muted-foreground">
        Send SOL to this address to fund your wallet and cover activation. The cost
        currently requires about {requiredSol.toFixed(4)} SOL.
      </Text>
      <TouchableOpacity onPress={onCopy} accessibilityLabel="Copy deposit address">
        <View style={{ flexDirection: "row" }} className="mt-1 w-full items-center justify-between gap-2 border border-border bg-muted p-3">
          <Text selectable style={s.mono} className="flex-1">
            {address ? `${address.slice(0, 8)}…${address.slice(-8)}` : "—"}
          </Text>
          {copied ? (
            <Text className="font-sans text-xs text-success">Copied</Text>
          ) : (
            <Copy size={14} className="text-muted-foreground" />
          )}
        </View>
      </TouchableOpacity>
      <Text style={s.hint}>
        Balance: {balanceSol.toFixed(4)} SOL{balanceSol < requiredSol ? ` — top up to at least ${requiredSol.toFixed(4)} SOL` : ""}.
      </Text>
    </View>
  );
}
