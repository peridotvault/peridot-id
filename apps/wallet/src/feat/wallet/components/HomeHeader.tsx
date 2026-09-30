import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Link2 } from "../../../shared/icons";
import { theme } from "../../../shared/theme";

export function HomeHeader({
  pid,
  displayName,
  onConnections,
}: {
  pid: string | null;
  displayName: string | null;
  onConnections: () => void;
}) {
  return (
    <View style={styles.topRow}>
      <View style={styles.identity}>
        <Text style={styles.pid}>{pid ?? "…"}</Text>
        {displayName ? <Text style={styles.displayName}>{displayName}</Text> : null}
      </View>
      <TouchableOpacity style={styles.connBtn} onPress={onConnections} accessibilityLabel="App connections">
        <Link2 size={18} color={theme.colors.foreground} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  identity: { flex: 1, gap: 4 },
  pid: { fontSize: 20, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  displayName: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  connBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
});
