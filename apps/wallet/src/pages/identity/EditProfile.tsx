import { useCallback, useEffect, useState } from "react";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { TextField } from "../../shared/components/ui/TextField";
import type { Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { clearApiCache } from "../../shared/data/apiCache";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";

export function EditProfile({ onDone }: { onDone: () => void }) {
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
      // The shell top bar reads profile through the shared 30s cache — drop it
      // so the new name/photo shows on the way back.
      clearApiCache();
      setSaved(true);
      setProfile(res as Profile);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 12 }}>
      <PushHeader onBack={onDone} title="Edit Profile" />

      {profile?.avatarUrl ? (
        <img src={profile.avatarUrl} alt="" className="h-16 w-16 self-center rounded-full border border-border"  />
      ) : (
        <div className="flex flex-col h-16 w-16 items-center justify-center self-center rounded-full border border-border bg-surface" aria-label="No profile photo">
          <span aria-hidden="true" className="font-serif text-3xl text-foreground">{(profile?.displayName ?? "?").slice(0, 1).toUpperCase()}</span>
        </div>
      )}

      {pid ? <span className="text-center font-sans text-sm text-muted-foreground">@{pid} · permanent, cannot be changed</span> : null}

      <span style={s.label}>Display Name</span>
      <TextField style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={displayName} onChangeText={setDisplayName} placeholder="Display name"  />

      {error && <p role="alert" style={s.error}>{error}</p>}
      {saved && <span className="font-sans text-sm text-success">Saved</span>}
      <UIButton title={busy ? "Saving…" : "Save"} onPress={save} disabled={busy} variant="primary" />
    </ScrollArea>
  );
}
