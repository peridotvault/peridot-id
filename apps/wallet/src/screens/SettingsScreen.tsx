import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ChevronRight, Shield, User, Link2, TriangleAlert, ArrowLeft } from "lucide-react-native";
import { theme, styles as s } from "../theme";

interface Props {
  goProfile: () => void;
  goSecurity: () => void;
  goConnected: () => void;
  goDanger: () => void;
  onDone: () => void;
}

export function SettingsScreen({ goProfile, goSecurity, goConnected, goDanger, onDone }: Props) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <Text style={s.title}>Settings</Text>

      <Text style={styles.section}>Account</Text>
      <Row icon={User} label="Profile" onPress={goProfile} />
      <Row icon={Shield} label="Security" onPress={goSecurity} />
      <Row icon={Link2} label="Connected Accounts" onPress={goConnected} />

      <Text style={styles.section}>Danger Zone</Text>
      <Row icon={TriangleAlert} label="Delete Account" onPress={goDanger} danger />
    </ScrollView>
  );
}

function Row({
  icon: Icon,
  label,
  onPress,
  danger,
}: {
  icon: typeof User;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <View style={[styles.icon, danger && styles.iconDanger]}>
        <Icon size={18} color={danger ? theme.colors.danger : theme.colors.foreground} />
      </View>
      <Text style={[styles.label, danger && { color: theme.colors.danger }]}>{label}</Text>
      <ChevronRight size={16} color={theme.colors.mutedForeground} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 10 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  section: {
    fontSize: 12,
    color: theme.colors.mutedForeground,
    fontWeight: "600",
    fontFamily: theme.fonts.sansSemiBold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  iconDanger: { backgroundColor: theme.colors.dangerTint },
  label: { flex: 1, fontSize: 15, fontWeight: "500", color: theme.colors.foreground, fontFamily: theme.fonts.sansMedium },
});