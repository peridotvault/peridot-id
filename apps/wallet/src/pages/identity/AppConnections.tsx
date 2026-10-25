import { useCallback, useEffect, useState } from "react";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { Pressable } from "../../shared/components/ui/Pressable";
import { Link2 } from "../../shared/components/icons";
import type { SsoGrant } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { cachedRead, invalidate } from "../../shared/data/api-cache";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";

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

export function AppConnections({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [grants, setGrants] = useState<SsoGrant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justRevoked, setJustRevoked] = useState(false);

  const load = useCallback(async () => {
    const res = await cachedRead("auth.grants", { ttlMs: 60_000, tier: "session" }, () => peridot.auth.grants());
    setGrants(Array.isArray(res) ? (res as SsoGrant[]) : []);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const disconnect = async (id: string, label: string) => {
    if (
      !window.confirm(
        `Disconnect ${label}?\n\nFuture sign-ins there stop. The site keeps its own session — sign out on the site too.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await peridot.auth.revokeGrant(id);
      invalidate("auth.grants");
      setJustRevoked(true);
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
        title="App Connections"
        subtitle="Sites you signed in to with PeridotID. Disconnecting stops future sign-ins there."
      />

      {error && <p role="alert" style={s.error}>{error}</p>}
      {justRevoked && <span className="font-sans text-sm text-success">Site disconnected.</span>}

      {grants.map((g) => {
        const host = hostOf(g.origin);
        const label = g.name ?? host;
        return (
          <div key={g.id} style={s.card} className="flex flex-col">
            <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3">
              <div className="flex flex-col flex h-9 w-9 items-center justify-center rounded-full bg-muted">
                <Link2 size={16} className="text-foreground" />
              </div>
              <div className="flex flex-col flex-1 gap-0.5">
                <span className="font-sans text-base font-semibold text-foreground" aria-label={`${label}${g.isVerified ? ", verified" : ""}`}>
                  {label}
                  {g.isVerified && <span aria-hidden="true"> ✓</span>}
                </span>
                {g.name && <span className="font-sans text-xs text-muted-foreground">{host}</span>}
                <span className="font-sans text-xs text-muted-foreground">Connected {fmtDate(g.firstSeenAt)}</span>
                <span className="font-sans text-xs text-muted-foreground">Last used {fmtDate(g.lastUsedAt)}</span>
              </div>
              <Pressable onPress={() => disconnect(g.id, label)} disabled={busy}>
                <span className="font-sans text-sm text-danger">Disconnect</span>
              </Pressable>
            </div>
          </div>
        );
      })}

      {grants.length === 0 && <p style={s.hint}>No connected sites yet.</p>}
    </ScrollArea>
  );
}
