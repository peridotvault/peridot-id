import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowLeft, ChevronRight, KeyRound, Monitor, Link2 } from "lucide-react-native";
import type { Authority, IdentityCredential } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

interface Props {
  goPasskeys: () => void;
  goSessions: () => void;
  goConnected: () => void;
  onDone: () => void;
}

export function SecurityScreen({ goPasskeys, goSessions, goConnected, onDone }: Props) {
  const { peridot } = usePeridot();
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [credentials, setCredentials] = useState<IdentityCredential[]>([]);
  const [sessions, setSessions] = useState<unknown[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    const [pk, creds, sess] = await Promise.all([
      peridot.passkey.list().catch(() => []),
      peridot.identity.credentials().catch(() => []),
      peridot.auth.sessions().catch(() => []),
    ]);
    setPasskeys(Array.isArray(pk) ? (pk as Authority[]) : []);
    setCredentials(Array.isArray(creds) ? (creds as IdentityCredential[]) : []);
    setSessions(Array.isArray(sess) ? (sess as unknown[]) : []);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const signOutOthers = async () => {
    setBusy(true);
    try {
      await peridot.auth.revokeOtherSessions();
      setDone(true);
      await load();
    } catch {
      setDone(false);
    } finally {
      setBusy(false);
    }
  };

  const google = credentials.find((c) => c.provider === "google");

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <Text style={s.title}>Security</Text>

      <Row icon={KeyRound} label={`Passkeys`} value={`${passkeys.length} active`} onPress={goPasskeys} />
      <Row icon={Link2} label="Recovery" value={google ? "Google · Connected" : "Add Google"} onPress={goConnected} />
      <Row icon={Monitor} label="Sessions / Devices" value={`${sessions.length} active`} onPress={goSessions} />

      <Text style={s.label}>Sign out other devices</Text>
      <UIButton title={busy ? "Signing out…" : "Sign out other sessions"} onPress={signOutOthers} disabled={busy || sessions.length <= 1} />
      {done && <Text style={styles.done}>Other sessions signed out.</Text>}
    </ScrollView>
  );
}

function Row({
  icon: Icon,
  label,
  value,
  onPress,
}: {
  icon: typeof KeyRound;
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <View style={styles.icon}>
        <Icon size={18} color={theme.colors.foreground} />
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
      <ChevronRight size={16} color={theme.colors.mutedForeground} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 14 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
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
  rowLabel: { flex: 1, fontSize: 15, fontWeight: "500", color: theme.colors.foreground, fontFamily: theme.fonts.sansMedium },
  value: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  done: { color: theme.colors.success, fontSize: 13, fontFamily: theme.fonts.sans },
});