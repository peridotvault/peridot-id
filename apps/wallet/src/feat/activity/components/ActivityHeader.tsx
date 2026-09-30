import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { RefreshCw } from "../../../shared/icons";
import { theme, styles as s } from "../../../shared/theme";
import type { Tab } from "../utils/feed";

export function ActivityHeader({
  tab,
  onTabChange,
  onRefresh,
  busy,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  return (
    <>
      <View style={styles.headRow}>
        <Text style={s.title}>Activity</Text>
        <TouchableOpacity style={styles.iconBtn} onPress={onRefresh} disabled={busy}>
          <RefreshCw size={16} color={theme.colors.foreground} />
        </TouchableOpacity>
      </View>

      <View style={styles.tabs}>
        <TabButton label="All" active={tab === "all"} onPress={() => onTabChange("all")} />
        <TabButton label="Onchain" active={tab === "onchain"} onPress={() => onTabChange("onchain")} />
        <TabButton label="IDR" active={tab === "idr"} onPress={() => onTabChange("idr")} />
      </View>
    </>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.tab, active && styles.tabActive]}
      onPress={onPress}
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
  },
  tabs: { flexDirection: "row", borderWidth: 1, borderColor: theme.colors.border },
  tab: { flex: 1, alignItems: "center", paddingVertical: 10, backgroundColor: theme.colors.background },
  tabActive: { backgroundColor: theme.colors.foreground },
  tabLabel: { fontSize: 13, fontWeight: "500", color: theme.colors.mutedForeground, fontFamily: theme.fonts.sansMedium },
  tabLabelActive: { color: theme.colors.background },
});
