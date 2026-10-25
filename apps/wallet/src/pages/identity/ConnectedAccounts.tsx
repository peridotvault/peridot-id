import { useCallback, useEffect, useState } from "react";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { Pressable } from "../../shared/components/ui/Pressable";
import { Link2 } from "../../shared/components/icons";
import type { IdentityCredential } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { cachedRead, invalidate } from "../../shared/data/apiCache";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";

export function ConnectedAccounts({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [credentials, setCredentials] = useState<IdentityCredential[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justUnlinked, setJustUnlinked] = useState(false);

  const load = useCallback(async () => {
    const res = await cachedRead("identity.credentials", { ttlMs: 60_000, tier: "session" }, () => peridot.identity.credentials());
    setCredentials(Array.isArray(res) ? (res as IdentityCredential[]) : []);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const unlink = async (id: string, provider: string) => {
    if (
      !window.confirm(
        `Unlink ${provider}?\n\nGoogle works as a recovery login. Unlinking it means you rely on your passkeys to sign in.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await peridot.identity.unlinkCredential(id);
      invalidate("identity.credentials");
      setJustUnlinked(true);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 14 }}>
      <PushHeader
        onBack={onDone}
        title="Connected Accounts"
        subtitle="Login methods linked to this Peridot ID. Google is the fallback/recovery path for your passkeys."
      />

      {error && <p role="alert" style={s.error}>{error}</p>}
      {justUnlinked && <span className="font-sans text-sm text-success">Account unlinked.</span>}

      {credentials.map((c) => (
        <div key={c.id} style={s.card} className="flex flex-col">
          <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3">
            <div className="flex flex-col flex h-9 w-9 items-center justify-center rounded-full bg-muted">
              <Link2 size={16} className="text-foreground" />
            </div>
            <div className="flex flex-col flex-1 gap-0.5">
              <span className="font-sans text-base font-semibold text-foreground">{c.provider === "google" ? "Google" : c.provider}</span>
              <span className="font-sans text-xs text-muted-foreground">{c.email ?? "No email"}</span>
              {c.lastLoginAt && <span className="font-sans text-xs text-muted-foreground">Last login {new Date(c.lastLoginAt).toLocaleString()}</span>}
            </div>
            {credentials.length > 1 && (
              <Pressable onPress={() => unlink(c.id, c.provider)} disabled={busy}>
                <span className="font-sans text-sm text-danger">Unlink</span>
              </Pressable>
            )}
          </div>
          {credentials.length <= 1 && <span className="font-sans text-xs text-muted-foreground">Keep at least one login method.</span>}
        </div>
      ))}

    </ScrollArea>
  );
}
