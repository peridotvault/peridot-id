import { useCallback, useEffect, useState } from "react";
import { Image, ScrollView, Text, TextInput, View } from "../shared/primitives";
import type { Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { UIButton } from "../shared/components/UIButton";

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
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 12 }}>
      <Text style={s.title}>Edit Profile</Text>

      {profile?.avatarUrl ? (
        <Image source={{ uri: profile.avatarUrl }} className="h-16 w-16 self-center rounded-full border border-border" />
      ) : (
        <View className="h-16 w-16 items-center justify-center self-center rounded-full border border-border bg-surface">
          <Text className="font-serif text-[28px] text-foreground">{(profile?.displayName ?? "?").slice(0, 1).toUpperCase()}</Text>
        </View>
      )}

      {pid ? <Text className="text-center font-sans text-[13px] text-muted-foreground">@{pid} · permanent, cannot be changed</Text> : null}

      <Text style={s.label}>Display Name</Text>
      <TextInput style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={displayName} onChangeText={setDisplayName} placeholder="Display name" />

      {error && <Text style={s.error}>{error}</Text>}
      {saved && <Text className="font-sans text-[13px] text-success">Saved</Text>}
      <UIButton title={busy ? "Saving…" : "Save"} onPress={save} disabled={busy} variant="primary" />
      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}
