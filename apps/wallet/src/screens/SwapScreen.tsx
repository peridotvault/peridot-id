import { useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "../shared/primitives";
import { ArrowDownUp } from "../shared/icons";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { UIButton } from "../shared/components/UIButton";

export function SwapScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [from, setFrom] = useState("SOL");
  const [to, setTo] = useState("USDC");
  const [amount, setAmount] = useState("");

  const swap = async () => {
    // ponytail: swap is a stub — no DEX/quote backend exists yet.
  };

  return (
    <View style={s.container}>
      <Text style={s.title}>Swap</Text>
      <Text style={s.subtitle}>Swap between assets on the smart account.</Text>

      <View className="gap-2">
        <Text style={s.label}>You pay</Text>
        <TextInput style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="0.0" />
        <Text style={s.label}>From asset</Text>
        <TextInput style={s.input} value={from} onChangeText={setFrom} autoCapitalize="none" />

        <View style={{ flexDirection: "row" }} className="my-2 items-center gap-3">
          <View className="h-px flex-1 bg-border" />
          <View className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface">
            <ArrowDownUp size={16} className="text-foreground" />
          </View>
          <View className="h-px flex-1 bg-border" />
        </View>

        <Text style={s.label}>You receive</Text>
        <Text className="font-mono text-[18px] font-semibold text-foreground">≈ {amount || "0.0"}</Text>
        <Text style={s.label}>To asset</Text>
        <TextInput style={s.input} value={to} onChangeText={setTo} autoCapitalize="none" />
      </View>

      <TouchableOpacity onPress={swap}>
        <View className="w-full items-center border border-border bg-surface p-3.5">
          <Text className="font-sans text-[13px] font-medium text-muted-foreground">Swap coming soon</Text>
        </View>
      </TouchableOpacity>
      <UIButton title="Back" onPress={onDone} />
    </View>
  );
}
