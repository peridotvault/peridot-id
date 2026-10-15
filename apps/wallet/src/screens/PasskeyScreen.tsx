import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "../shared/primitives";
import { KeyRound, Plus, Trash2 } from "../shared/icons";
import type { Authority } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { UIButton } from "../shared/components/UIButton";

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
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 16 }}>
      <Text style={s.title}>Passkeys</Text>
      <Text style={s.subtitle}>
        Passkeys authorize your on-chain wallet (secp256r1). Register one on this device to
        sign in and authorize withdrawals. Your last passkey cannot be removed.
      </Text>
      {error && <Text style={s.error}>{error}</Text>}

      <TouchableOpacity onPress={register} disabled={busy}>
        <View style={{ flexDirection: "row" }} className="w-full items-center justify-center gap-2 border border-border bg-surface py-3">
          <Plus size={16} className="text-foreground" />
          <Text className="font-sans text-sm font-medium text-foreground">{busy ? "Waiting for passkey…" : "Add Passkey"}</Text>
        </View>
      </TouchableOpacity>
      {authorities.length > 0 && (
        <Text style={s.hint}>One platform passkey per device — add extras from another device or a security key.</Text>
      )}

      {authorities.map((a) => (
        <View key={a.id} style={s.card}>
          <View style={{ flexDirection: "row" }} className="items-center gap-3">
            <View className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
              <KeyRound size={16} className="text-foreground" />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="font-sans text-[15px] font-semibold text-foreground">Passkey</Text>
              <Text className="font-sans text-xs text-muted-foreground">Added {fmtDate(a.createdAt)}</Text>
              <Text className="font-sans text-xs text-muted-foreground">Last used {fmtDate(a.lastUsedAt)}</Text>
              {a.credentialId && (
                <Text className="font-mono text-xs text-muted-foreground" numberOfLines={1}>
                  ID {a.credentialId}
                </Text>
              )}
            </View>
            <TouchableOpacity
              onPress={() => revoke(a.id)}
              disabled={busy || onlyOne}
              accessibilityLabel={`Remove passkey ${a.credentialId ?? a.id}`}
            >
              <View className={`p-2 ${onlyOne ? "opacity-40" : ""}`}>
                <Trash2 size={16} className={onlyOne ? "text-muted-foreground" : "text-danger"} />
              </View>
            </TouchableOpacity>
          </View>
          {onlyOne && (
            <Text className="font-sans text-xs text-muted-foreground">This is your only passkey — keep it to stay able to sign in.</Text>
          )}
        </View>
      ))}

      {authorities.length === 0 && <Text style={s.hint}>No passkeys yet. Add one above.</Text>}

      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}
