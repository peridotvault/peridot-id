import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowLeft, Link2 } from "../icons";
import type { SsoGrant } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function AppConnectionsScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [grants, setGrants] = useState<SsoGrant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justRevoked, setJustRevoked] = useState(false);

  const load = useCallback(async () => {
    const res = await peridot.auth.grants();
    setGrants(Array.isArray(res) ? (res as SsoGrant[]) : []);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const disconnect = (id: string, label: string) => {
    Alert.alert(
      `Disconnect ${label}?`,
      "Future sign-ins there stop. The site keeps its own session — sign out on the site too.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            setError(null);
            try {
              await peridot.auth.revokeGrant(id);
              setJustRevoked(true);
              await load();
            } catch (e) {
              setError(String(e));
            } finally {
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

      <Text style={s.title}>App Connections</Text>
      <Text style={s.subtitle}>Sites you signed in to with PeridotID. Disconnecting stops future sign-ins there.</Text>

      {error && <Text style={s.error}>{error}</Text>}
      {justRevoked && <Text style={styles.done}>Site disconnected.</Text>}

      {grants.map((g) => {
        const host = hostOf(g.origin);
        const label = g.name ?? host;
        return (
          <View key={g.id} style={s.card}>
            <View style={styles.row}>
              <View style={styles.icon}>
                <Link2 size={16} color={theme.colors.foreground} />
              </View>
              <View style={styles.meta}>
                <Text style={styles.site}>{label}</Text>
                {g.name && <Text style={styles.muted}>{host}</Text>}
                <Text style={styles.muted}>Connected {fmtDate(g.firstSeenAt)}</Text>
                <Text style={styles.muted}>Last used {fmtDate(g.lastUsedAt)}</Text>
              </View>
              <TouchableOpacity onPress={() => disconnect(g.id, label)} disabled={busy}>
                <Text style={styles.disconnect}>Disconnect</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}

      {grants.length === 0 && <Text style={s.hint}>No connected sites yet.</Text>}

      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  container: { padding: 24, gap: 14 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: c.foreground, fontFamily: f.sans },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  meta: { flex: 1, gap: 2 },
  site: { fontSize: 15, fontWeight: "600", color: c.foreground, fontFamily: f.sansSemiBold },
  muted: { fontSize: 12, color: c.mutedForeground, fontFamily: f.sans },
  disconnect: { fontSize: 13, color: c.danger, fontFamily: f.sans },
  done: { color: c.success, fontSize: 13, fontFamily: f.sans },
});
