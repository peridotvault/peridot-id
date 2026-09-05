import { useCallback, useEffect, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { KeyRound, Plus, Trash2 } from "lucide-react-native";
import type { Authority } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";

function fmtDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function PasskeyScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [authorities, setAuthorities] = useState<Authority[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await peridot.passkey.list();
    setAuthorities(Array.isArray(res) ? (res as Authority[]) : []);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const register = async () => {
    setBusy(true);
    setError(null);
    try {
      await peridot.passkey.register();
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
      const res = await peridot.passkey.revoke(id);
      if ("statusCode" in res) throw new Error((res as { message: string | string[] }).message as string);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onlyOne = authorities.length <= 1;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text style={s.title}>Passkeys</Text>
      <Text style={s.subtitle}>
        Passkeys authorize your on-chain wallet (secp256r1). Register one on this device to
        sign in and authorize withdrawals. Your last passkey cannot be removed.
      </Text>
      {error && <Text style={s.error}>{error}</Text>}

      <TouchableOpacity style={styles.addBtn} onPress={register} disabled={busy}>
        <Plus size={16} color={theme.colors.foreground} />
        <Text style={styles.addLabel}>{busy ? "Waiting for passkey…" : "Add Passkey"}</Text>
      </TouchableOpacity>
      {authorities.length > 0 && (
        <Text style={s.hint}>One platform passkey per device — add extras from another device or a security key.</Text>
      )}

      {authorities.map((a) => (
        <View key={a.id} style={s.card}>
          <View style={styles.row}>
            <View style={styles.icon}>
              <KeyRound size={16} color={theme.colors.foreground} />
            </View>
            <View style={styles.meta}>
              <Text style={styles.device}>Passkey</Text>
              <Text style={styles.muted}>Added {fmtDate(a.createdAt)}</Text>
              <Text style={styles.muted}>Last used {fmtDate(a.lastUsedAt)}</Text>
              {a.credentialId && (
                <Text style={[styles.muted, styles.short]} numberOfLines={1}>
                  ID {a.credentialId}
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={[styles.remove, onlyOne && styles.removeDisabled]}
              onPress={() => revoke(a.id)}
              disabled={busy || onlyOne}
              accessibilityLabel={`Remove passkey ${a.credentialId ?? a.id}`}
            >
              <Trash2 size={16} color={onlyOne ? theme.colors.mutedForeground : theme.colors.danger} />
            </TouchableOpacity>
          </View>
          {onlyOne && (
            <Text style={styles.lastHint}>This is your only passkey — keep it to stay able to sign in.</Text>
          )}
        </View>
      ))}

      {authorities.length === 0 && <Text style={s.hint}>No passkeys yet. Add one above.</Text>}

      <Button title="Back" onPress={onDone} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 16 },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  addLabel: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
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
  device: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground },
  muted: { fontSize: 12, color: theme.colors.mutedForeground },
  short: { fontFamily: "monospace" },
  remove: { padding: 8 },
  removeDisabled: { opacity: 0.4 },
  lastHint: { fontSize: 12, color: theme.colors.mutedForeground },
});