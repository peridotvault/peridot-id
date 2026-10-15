import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "../shared/primitives";
import { Monitor, LogOut } from "../shared/icons";
import type { Session } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { BackButton } from "../shared/components/BackButton";
import { UIButton } from "../shared/components/UIButton";

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
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 14 }}>
      <BackButton onPress={onDone} />

      <Text style={s.title}>Sessions / Devices</Text>
      <Text style={s.subtitle}>Devices currently signed in to your Peridot ID.</Text>

      {error && <Text style={s.error}>{error}</Text>}

      {sessions.length > 1 && (
        <UIButton title={busy ? "Signing out…" : "Sign out other sessions"} onPress={revokeAllOthers} disabled={busy} />
      )}

      {sessions.map((se) => (
        <View key={se.id} style={s.card}>
          <View style={{ flexDirection: "row" }} className="items-center gap-3">
            <View className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
              <Monitor size={16} className="text-foreground" />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="font-sans text-sm font-semibold text-foreground">
                {se.userAgent ?? "Unknown device"}
                {se.isCurrent ? "  ·  this device" : ""}
              </Text>
              <Text className="font-sans text-xs text-muted-foreground">Signed in {fmtDate(se.createdAt)}</Text>
              <Text className="font-sans text-xs text-muted-foreground">Seen {se.lastSeenAt ? fmtDate(se.lastSeenAt) : "—"} · Expires {fmtDate(se.expiresAt)}</Text>
            </View>
            {!se.isCurrent && (
              <TouchableOpacity onPress={() => revoke(se.id)} disabled={busy} accessibilityLabel="Sign out session">
                <View className="p-2">
                  <LogOut size={16} className="text-danger" />
                </View>
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
