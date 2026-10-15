import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, Text, TouchableOpacity, View } from "../shared/primitives";
import { Link2 } from "../shared/icons";
import type { SsoGrant } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { BackButton } from "../shared/components/BackButton";
import { UIButton } from "../shared/components/UIButton";

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
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 14 }}>
      <BackButton onPress={onDone} />

      <Text style={s.title}>App Connections</Text>
      <Text style={s.subtitle}>Sites you signed in to with PeridotID. Disconnecting stops future sign-ins there.</Text>

      {error && <Text style={s.error}>{error}</Text>}
      {justRevoked && <Text className="font-sans text-[13px] text-success">Site disconnected.</Text>}

      {grants.map((g) => {
        const host = hostOf(g.origin);
        const label = g.name ?? host;
        return (
          <View key={g.id} style={s.card}>
            <View style={{ flexDirection: "row" }} className="items-center gap-3">
              <View className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
                <Link2 size={16} className="text-foreground" />
              </View>
              <View className="flex-1 gap-0.5">
                <Text className="font-sans text-[15px] font-semibold text-foreground">
                  {label}
                  {g.isVerified ? " ✓" : ""}
                </Text>
                {g.name && <Text className="font-sans text-xs text-muted-foreground">{host}</Text>}
                <Text className="font-sans text-xs text-muted-foreground">Connected {fmtDate(g.firstSeenAt)}</Text>
                <Text className="font-sans text-xs text-muted-foreground">Last used {fmtDate(g.lastUsedAt)}</Text>
              </View>
              <TouchableOpacity onPress={() => disconnect(g.id, label)} disabled={busy}>
                <Text className="font-sans text-[13px] text-danger">Disconnect</Text>
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
