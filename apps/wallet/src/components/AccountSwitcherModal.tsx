import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { AccountView } from "@peridotvault/pid-types";
import { Check, LogOut, Plus, X } from "../icons";
import { theme, styles as s } from "../theme";
import { UIButton } from "./UIButton";

// Bottom-sheet account switcher: every identity signed into this browser, the
// active one checked, "Add Account" at the bottom. Selecting switches the active
// session; the app re-bootstraps onto the chosen identity.
export function AccountSwitcherModal({
  visible,
  accounts,
  busy,
  error,
  onClose,
  onSelect,
  onAdd,
  onSignOut,
}: {
  visible: boolean;
  accounts: AccountView[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (pid: string) => void;
  onAdd: () => void;
  onSignOut: (pid: string) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={busy ? undefined : onClose} accessibilityLabel="Close account switcher" />
      <View style={styles.sheet}>
        <View style={styles.head}>
          <Text style={styles.title}>Switch Account</Text>
          <Pressable onPress={onClose} disabled={busy} style={styles.close} accessibilityLabel="Close">
            <X size={18} color={theme.colors.mutedForeground} />
          </Pressable>
        </View>

        {error && <Text style={s.error}>{error}</Text>}

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {accounts.map((a) => (
            <Pressable
              key={a.pid}
              style={styles.row}
              onPress={() => onSelect(a.pid)}
              disabled={busy || a.isActive}
              accessibilityLabel={`Switch to ${a.pid}`}
            >
              {a.avatarUrl ? (
                <Image source={{ uri: a.avatarUrl }} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, styles.thumbFallback]}>
                  <Text style={styles.thumbText}>{(a.displayName ?? a.pid).slice(0, 1).toUpperCase()}</Text>
                </View>
              )}
              <View style={styles.meta}>
                <Text style={styles.name} numberOfLines={1}>
                  {a.displayName ?? a.pid}
                </Text>
                <Text style={styles.pid} numberOfLines={1}>
                  {a.pid}
                </Text>
              </View>
              {a.isActive ? (
                <Check size={18} color={theme.colors.foreground} />
              ) : (
                <Pressable
                  onPress={() => onSignOut(a.pid)}
                  disabled={busy}
                  style={styles.rowAction}
                  accessibilityLabel={`Sign out ${a.pid}`}
                >
                  <LogOut size={16} color={theme.colors.mutedForeground} />
                </Pressable>
              )}
            </Pressable>
          ))}
          {accounts.length === 0 && <Text style={s.hint}>No accounts signed in.</Text>}
        </ScrollView>

        <UIButton
          title="Add Account"
          onPress={onAdd}
          disabled={busy}
          variant="primary"
          icon={<Plus size={16} color={theme.colors.foreground} />}
        />
      </View>
    </Modal>
  );
}

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0, 0, 0, 0.6)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "75%",
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderColor: c.border,
    padding: 20,
    paddingBottom: 28,
    gap: 12,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 22, color: c.foreground, fontFamily: f.serif, letterSpacing: -0.3 },
  close: { padding: 6 },
  list: { flexGrow: 0 },
  listContent: { gap: 8, paddingVertical: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: c.border,
  },
  thumb: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: c.border },
  thumbFallback: { backgroundColor: c.muted, alignItems: "center", justifyContent: "center", borderWidth: 0 },
  thumbText: { fontSize: 15, color: c.foreground, fontFamily: f.serif },
  meta: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: "500", color: c.foreground, fontFamily: f.sansMedium },
  pid: { fontSize: 12, color: c.mutedForeground, fontFamily: f.sans },
  rowAction: { padding: 8 },
});
