import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, Alert } from "react-native";
import { ArrowLeft, Link2 } from "lucide-react-native";
import type { IdentityCredential } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

export function ConnectedAccountsScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [credentials, setCredentials] = useState<IdentityCredential[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justUnlinked, setJustUnlinked] = useState(false);

  const load = useCallback(async () => {
    const res = await peridot.identity.credentials();
    setCredentials(Array.isArray(res) ? (res as IdentityCredential[]) : []);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const unlink = async (id: string, provider: string) => {
    Alert.alert(
      `Unlink ${provider}?`,
      "Google works as a recovery login. Unlinking it means you rely on your passkeys to sign in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unlink",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            setError(null);
            try {
              await peridot.identity.unlinkCredential(id);
              setJustUnlinked(true);
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

      <Text style={s.title}>Connected Accounts</Text>
      <Text style={s.subtitle}>Login methods linked to this Peridot ID. Google is the fallback/recovery path for your passkeys.</Text>

      {error && <Text style={s.error}>{error}</Text>}
      {justUnlinked && <Text style={styles.done}>Account unlinked.</Text>}

      {credentials.map((c) => (
        <View key={c.id} style={s.card}>
          <View style={styles.row}>
            <View style={styles.icon}>
              <Link2 size={16} color={theme.colors.foreground} />
            </View>
            <View style={styles.meta}>
              <Text style={styles.provider}>{c.provider === "google" ? "Google" : c.provider}</Text>
              <Text style={styles.muted}>{c.email ?? "No email"}</Text>
              {c.lastLoginAt && <Text style={styles.muted}>Last login {new Date(c.lastLoginAt).toLocaleString()}</Text>}
            </View>
            {credentials.length > 1 && (
              <TouchableOpacity onPress={() => unlink(c.id, c.provider)} disabled={busy}>
                <Text style={styles.unlink}>Unlink</Text>
              </TouchableOpacity>
            )}
          </View>
          {credentials.length <= 1 && <Text style={styles.hint}>Keep at least one login method.</Text>}
        </View>
      ))}

      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 14 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  meta: { flex: 1, gap: 2 },
  provider: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  muted: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  unlink: { fontSize: 13, color: theme.colors.danger, fontFamily: theme.fonts.sans },
  hint: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  done: { color: theme.colors.success, fontSize: 13, fontFamily: theme.fonts.sans },
});