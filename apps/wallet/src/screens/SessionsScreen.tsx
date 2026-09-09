import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowLeft, Monitor, LogOut } from "lucide-react-native";
import type { Session } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SessionsScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await peridot.auth.sessions();
    setSessions(Array.isArray(res) ? (res as Session[]) : []);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const revokeAllOthers = async () => {
    setBusy(true);
    setError(null);
    try {
      await peridot.auth.revokeOtherSessions();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await peridot.auth.revokeSession(id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <Text style={s.title}>Sessions / Devices</Text>
      <Text style={s.subtitle}>Devices currently signed in to your Peridot ID.</Text>

      {error && <Text style={s.error}>{error}</Text>}

      {sessions.length > 1 && (
        <UIButton title={busy ? "Signing out…" : "Sign out other sessions"} onPress={revokeAllOthers} disabled={busy} />
      )}

      {sessions.map((se) => (
        <View key={se.id} style={s.card}>
          <View style={styles.head}>
            <View style={styles.icon}>
              <Monitor size={16} color={theme.colors.foreground} />
            </View>
            <View style={styles.meta}>
              <Text style={styles.device}>
                {se.userAgent ?? "Unknown device"}
                {se.isCurrent ? "  ·  this device" : ""}
              </Text>
              <Text style={styles.muted}>Signed in {fmtDate(se.createdAt)}</Text>
              <Text style={styles.muted}>Seen {se.lastSeenAt ? fmtDate(se.lastSeenAt) : "—"} · Expires {fmtDate(se.expiresAt)}</Text>
            </View>
            {!se.isCurrent && (
              <TouchableOpacity style={styles.signOut} onPress={() => revoke(se.id)} disabled={busy} accessibilityLabel="Sign out session">
                <LogOut size={16} color={theme.colors.danger} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      ))}

      {sessions.length === 0 && <Text style={s.hint}>No active sessions.</Text>}

      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 14 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  meta: { flex: 1, gap: 2 },
  device: { fontSize: 14, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  muted: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  signOut: { padding: 8 },
});