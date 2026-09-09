import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { ArrowLeft, TriangleAlert } from "lucide-react-native";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

export function DangerZoneScreen({ onDone, onDeleted }: { onDone: () => void; onDeleted: () => void }) {
  const { peridot } = usePeridot();
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = confirmText.trim().toLowerCase() === "delete";

  const del = () => {
    Alert.alert(
      "Delete your Peridot ID?",
      "This permanently disables your Peridot ID and signs you out everywhere. Your Solana smart account and any assets in it are on-chain and remain yours — this only removes your Peridot ID access.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            setError(null);
            try {
              await peridot.identity.deleteAccount();
              onDeleted();
            } catch (e) {
              setError(String(e));
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Danger Zone</Text>
      <View style={[styles.warn, { borderColor: theme.colors.danger }]}>
        <TriangleAlert size={16} color={theme.colors.danger} />
        <Text style={styles.warnText}>
          Deleting your Peridot ID removes access to PeridotID. Assets already in your Solana
          smart account remain yours on-chain. This cannot be undone.
        </Text>
      </View>

      <Text style={s.label}>Type “delete” to confirm</Text>
      <TextInput
        style={s.input}
        value={confirmText}
        onChangeText={setConfirmText}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={theme.colors.mutedForeground}
      />

      {error && <Text style={s.error}>{error}</Text>}
      <UIButton title={busy ? "Deleting…" : "Delete Account"} onPress={del} disabled={!confirmed || busy} variant="danger" />
      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 14 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  title: { fontSize: 26, fontWeight: "700", color: theme.colors.danger, fontFamily: theme.fonts.sansBold },
  warn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 0,
    borderWidth: 1,
    padding: 14,
    backgroundColor: theme.colors.surface,
  },
  warnText: { flex: 1, fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
});