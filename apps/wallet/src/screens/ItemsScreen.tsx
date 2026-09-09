import { StyleSheet, Text, View } from "react-native";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

export function ItemsScreen({ onDone }: { onDone: () => void }) {
  return (
    <View style={s.container}>
      <Text style={s.title}>Items</Text>
      <Text style={s.subtitle}>Game items and collectibles on the smart account.</Text>

      <View style={styles.comingSoon}>
        <Text style={styles.comingSoonText}>Items coming soon</Text>
      </View>
      <UIButton title="Back" onPress={onDone} />
    </View>
  );
}

const styles = StyleSheet.create({
  comingSoon: {
    alignItems: "center",
    padding: 14,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  comingSoonText: {
    color: theme.colors.mutedForeground,
    fontSize: 13,
    fontWeight: "500",
    fontFamily: theme.fonts.sansMedium,
  },
});
