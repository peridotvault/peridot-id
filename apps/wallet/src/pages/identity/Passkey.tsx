import { useCallback, useEffect, useState } from "react";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { Pressable } from "../../shared/components/ui/Pressable";
import { KeyRound, Plus, Trash2 } from "../../shared/components/icons";
import type { Authority } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { cachedRead, invalidate } from "../../shared/data/api-cache";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";

function fmtDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function Passkey({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [authorities, setAuthorities] = useState<Authority[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await cachedRead("passkey.list", { ttlMs: 60_000, tier: "session" }, () => peridot.passkey.list());
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
      invalidate("passkey.list");
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
      invalidate("passkey.list");
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
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 16 }}>
      <PushHeader onBack={onDone} title="Passkeys" />
      <p style={s.subtitle}>
        Passkeys authorize your on-chain wallet (secp256r1). Register one on this device to
        sign in and authorize withdrawals. Your last passkey cannot be removed.
      </p>
      {error && <p role="alert" style={s.error}>{error}</p>}

      <Pressable onPress={register} disabled={busy}>
        <div style={{ flexDirection: "row" }} className="flex flex-col w-full items-center justify-center gap-2 border border-border bg-surface py-3">
          <Plus size={16} className="text-foreground" />
          <span className="font-sans text-sm font-medium text-foreground">{busy ? "Waiting for passkey…" : "Add Passkey"}</span>
        </div>
      </Pressable>
      {authorities.length > 0 && (
        <p style={s.hint}>One platform passkey per device — add extras from another device or a security key.</p>
      )}

      {authorities.map((a) => (
        <div key={a.id} style={s.card} className="flex flex-col">
          <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3">
            <div className="flex flex-col flex h-9 w-9 items-center justify-center rounded-full bg-muted">
              <KeyRound size={16} className="text-foreground" />
            </div>
            <div className="flex flex-col flex-1 gap-0.5">
              <span className="font-sans text-base font-semibold text-foreground">Passkey</span>
              <span className="font-sans text-xs text-muted-foreground">Added {fmtDate(a.createdAt)}</span>
              <span className="font-sans text-xs text-muted-foreground">Last used {fmtDate(a.lastUsedAt)}</span>
              {a.credentialId && (
                <span className="whitespace-nowrap overflow-hidden text-ellipsis font-mono text-xs text-muted-foreground" title={`ID ${a.credentialId}`}>
                  ID {a.credentialId}
                </span>
              )}
            </div>
            <Pressable
              onPress={() => revoke(a.id)}
              disabled={busy || onlyOne}
              accessibilityLabel={`Remove passkey ${a.credentialId ?? a.id}`}
            >
              <div className={`flex flex-col p-2 ${onlyOne ? "opacity-40" : ""}`}>
                <Trash2 size={16} className={onlyOne ? "text-muted-foreground" : "text-danger"} />
              </div>
            </Pressable>
          </div>
          {onlyOne && (
            <span className="font-sans text-xs text-muted-foreground">This is your only passkey — keep it to stay able to sign in.</span>
          )}
        </div>
      ))}

      {authorities.length === 0 && <p style={s.hint}>No passkeys yet. Add one above.</p>}

    </ScrollArea>
  );
}
