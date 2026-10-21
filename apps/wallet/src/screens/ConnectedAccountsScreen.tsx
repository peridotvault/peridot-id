import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View, Alert } from "../shared/primitives";
import { Link2 } from "../shared/icons";
import type { IdentityCredential } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { BackButton } from "../shared/components/BackButton";

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
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 14 }}>
      <BackButton onPress={onDone} />

      <Text style={s.title}>Connected Accounts</Text>
      <Text style={s.subtitle}>Login methods linked to this Peridot ID. Google is the fallback/recovery path for your passkeys.</Text>

      {error && <Text style={s.error}>{error}</Text>}
      {justUnlinked && <Text className="font-sans text-[13px] text-success">Account unlinked.</Text>}

      {credentials.map((c) => (
        <View key={c.id} style={s.card}>
          <View style={{ flexDirection: "row" }} className="items-center gap-3">
            <View className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
              <Link2 size={16} className="text-foreground" />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="font-sans text-[15px] font-semibold text-foreground">{c.provider === "google" ? "Google" : c.provider}</Text>
              <Text className="font-sans text-xs text-muted-foreground">{c.email ?? "No email"}</Text>
              {c.lastLoginAt && <Text className="font-sans text-xs text-muted-foreground">Last login {new Date(c.lastLoginAt).toLocaleString()}</Text>}
            </View>
            {credentials.length > 1 && (
              <TouchableOpacity onPress={() => unlink(c.id, c.provider)} disabled={busy}>
                <Text className="font-sans text-[13px] text-danger">Unlink</Text>
              </TouchableOpacity>
            )}
          </View>
          {credentials.length <= 1 && <Text className="font-sans text-xs text-muted-foreground">Keep at least one login method.</Text>}
        </View>
      ))}

    </ScrollView>
  );
}
