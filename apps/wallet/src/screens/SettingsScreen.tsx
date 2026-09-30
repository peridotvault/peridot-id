import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ChevronRight, KeyRound, Monitor, Link2, ArrowLeft, Check, Banknote } from "../shared/icons";
import type { Authority, IdentityCredential } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { theme, styles as s } from "../shared/theme";
import { CURRENCIES, getCurrency, setCurrency, type Currency } from "../shared/currency";

interface Props {
  goPasskeys: () => void;
  goSessions: () => void;
  goConnected: () => void;
  onDone: () => void;
}

export function SettingsScreen({ goPasskeys, goSessions, goConnected, onDone }: Props) {
  const { peridot } = usePeridot();
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [credentials, setCredentials] = useState<IdentityCredential[]>([]);
  const [sessions, setSessions] = useState<unknown[]>([]);
  const [currency, setCurrencyState] = useState<Currency>(getCurrency);

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

  const google = credentials.find((c) => c.provider === "google");

  const pickCurrency = useCallback((c: Currency) => {
    setCurrencyState(c);
    setCurrency(c);
  }, []);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <Text style={s.title}>Settings</Text>

      <Text style={styles.section}>Security</Text>
      <Row icon={KeyRound} label="Passkeys" value={`${passkeys.length} active`} onPress={goPasskeys} />
      <Row icon={Link2} label="Recovery" value={google ? "Google · Connected" : "Add Google"} onPress={goConnected} />
      <Row icon={Monitor} label="Sessions / Devices" value={`${sessions.length} active`} onPress={goSessions} />

      <Text style={styles.section}>Preferences</Text>
      <View style={styles.currencyCard}>
        <View style={styles.icon}>
          <Banknote size={18} color={theme.colors.foreground} />
        </View>
        <Text style={styles.label}>Currency</Text>
        {CURRENCIES.map((c) => (
          <TouchableOpacity
            key={c}
            style={[styles.currencyOpt, currency === c && styles.currencyOptActive]}
            onPress={() => pickCurrency(c)}
            accessibilityState={{ selected: currency === c }}
          >
            {currency === c && <Check size={14} color={theme.colors.foreground} />}
            <Text style={[styles.currencyText, currency === c && styles.currencyTextActive]}>{c}</Text>
          </TouchableOpacity>
        ))}
      </View>
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
  value?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <View style={styles.icon}>
        <Icon size={18} color={theme.colors.foreground} />
      </View>
      <Text style={styles.label}>{label}</Text>
      {value && <Text style={styles.value}>{value}</Text>}
      <ChevronRight size={16} color={theme.colors.mutedForeground} />
    </TouchableOpacity>
  );
}

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  container: { padding: 24, gap: 10 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: c.foreground, fontFamily: f.sans },
  section: {
    fontSize: 12,
    color: c.mutedForeground,
    fontWeight: "600",
    fontFamily: f.sansSemiBold,
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
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { flex: 1, fontSize: 15, fontWeight: "500", color: c.foreground, fontFamily: f.sansMedium },
  value: { fontSize: 13, color: c.mutedForeground, fontFamily: f.sans },
  currencyCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 14,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  currencyOpt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: c.border,
  },
  currencyOptActive: { borderColor: c.foreground },
  currencyText: { fontSize: 13, color: c.mutedForeground, fontFamily: f.sansMedium },
  currencyTextActive: { color: c.foreground },
});
