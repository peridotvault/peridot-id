import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { ArrowDownUp } from "../icons";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

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

      <View style={styles.swapCard}>
        <Text style={s.label}>You pay</Text>
        <TextInput style={s.input} value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="0.0" placeholderTextColor={theme.colors.mutedForeground} />
        <Text style={s.label}>From asset</Text>
        <TextInput style={s.input} value={from} onChangeText={setFrom} autoCapitalize="none" />

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <View style={styles.swapIcon}>
            <ArrowDownUp size={16} color={theme.colors.foreground} />
          </View>
          <View style={styles.dividerLine} />
        </View>

        <Text style={s.label}>You receive</Text>
        <Text style={styles.estimate}>≈ {amount || "0.0"}</Text>
        <Text style={s.label}>To asset</Text>
        <TextInput style={s.input} value={to} onChangeText={setTo} autoCapitalize="none" />
      </View>

      <TouchableOpacity style={styles.comingSoon} onPress={swap}>
        <Text style={styles.comingSoonText}>Swap coming soon</Text>
      </TouchableOpacity>
      <UIButton title="Back" onPress={onDone} />
    </View>
  );
}

const styles = StyleSheet.create({
  swapCard: { gap: 8 },
  divider: { flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 8 },
  dividerLine: { flex: 1, height: 1, backgroundColor: theme.colors.border },
  swapIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center" },
  estimate: { fontSize: 18, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.mono },
  comingSoon: { alignItems: "center", padding: 14, borderRadius: 0, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  comingSoonText: { color: theme.colors.mutedForeground, fontSize: 13, fontWeight: "500", fontFamily: theme.fonts.sansMedium },
});