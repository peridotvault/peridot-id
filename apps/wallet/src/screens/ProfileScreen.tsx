import { useCallback, useEffect, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { ArrowLeft } from "lucide-react-native";
import type { Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";

export function ProfileScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await peridot.profile.me();
    if ("statusCode" in res) return;
    setProfile(res as Profile);
    setDisplayName((res as Profile).displayName ?? "");
    setUsername((res as Profile).username ?? "");
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await peridot.profile.update({ displayName, username });
      if ("statusCode" in res) throw new Error((res as { message: string | string[] }).message as string);
      setSaved(true);
      setProfile(res as Profile);
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

      <Text style={s.title}>Profile</Text>

      {profile && (
        <View style={[styles.avatar, { backgroundColor: theme.colors.surface }]}>
          <Text style={styles.avatarText}>
            {(profile.displayName ?? profile.username ?? "?").slice(0, 1).toUpperCase()}
          </Text>
        </View>
      )}

      <Text style={s.label}>Display Name</Text>
      <TextInput style={s.input} value={displayName} onChangeText={setDisplayName} placeholder="Display name" placeholderTextColor={theme.colors.mutedForeground} />

      <Text style={s.label}>Username</Text>
      <TextInput style={s.input} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} placeholder="username" placeholderTextColor={theme.colors.mutedForeground} />

      {error && <Text style={s.error}>{error}</Text>}
      {saved && <Text style={styles.saved}>Saved</Text>}
      <Button title={busy ? "Saving…" : "Save"} onPress={save} disabled={busy} />
      <Button title="Back" onPress={onDone} />
    </ScrollView>
  );
}

function TouchableRow({ onDone }: { onDone: () => void }) {
  const { ArrowLeft } = require("lucide-react-native") as typeof import("lucide-react-native");
  return (
    <View style={styles.back} onTouchEnd={onDone}>
      <ArrowLeft size={18} color={theme.colors.foreground} />
      <Text style={styles.backLabel}>Back</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 12 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground },
  avatar: {
    alignSelf: "center",
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 28, fontWeight: "700", color: theme.colors.foreground, fontFamily: "serif" },
  saved: { color: theme.colors.success, fontSize: 13 },
});