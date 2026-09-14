import { useCallback, useEffect, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

export function EditProfileScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pid, setPid] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await peridot.profile.me();
    if ("statusCode" in res) return;
    setProfile(res as Profile);
    setDisplayName((res as Profile).displayName ?? "");
    const me = await peridot.identity.me();
    if (!("statusCode" in me)) setPid((me as { pid: string }).pid);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await peridot.profile.update({ displayName });
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
      <Text style={s.title}>Edit Profile</Text>

      {profile?.avatarUrl ? (
        <Image source={{ uri: profile.avatarUrl }} style={styles.photo} />
      ) : (
        <View style={[styles.photo, styles.photoFallback]}>
          <Text style={styles.avatarText}>{(profile?.displayName ?? "?").slice(0, 1).toUpperCase()}</Text>
        </View>
      )}

      {pid ? <Text style={styles.pid}>@{pid} · permanent, cannot be changed</Text> : null}

      <Text style={s.label}>Display Name</Text>
      <TextInput style={s.input} value={displayName} onChangeText={setDisplayName} placeholder="Display name" placeholderTextColor={theme.colors.mutedForeground} />

      {error && <Text style={s.error}>{error}</Text>}
      {saved && <Text style={styles.saved}>Saved</Text>}
      <UIButton title={busy ? "Saving…" : "Save"} onPress={save} disabled={busy} variant="primary" />
      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  container: { padding: 24, gap: 12 },
  photo: {
    alignSelf: "center",
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: c.border,
  },
  photoFallback: {
    backgroundColor: c.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 28, fontWeight: "400", color: c.foreground, fontFamily: f.serif },
  pid: { fontSize: 13, color: c.mutedForeground, fontFamily: f.sans, textAlign: "center" },
  saved: { color: c.success, fontSize: 13, fontFamily: f.sans },
});
