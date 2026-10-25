import { useCallback, useEffect, useState } from "react";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { Pressable } from "../../shared/components/ui/Pressable";
import { Monitor, LogOut } from "../../shared/components/icons";
import type { Session } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { cachedRead, invalidate } from "../../shared/data/apiCache";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function Sessions({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await cachedRead("auth.sessions", { ttlMs: 60_000, tier: "session" }, () => peridot.auth.sessions());
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
      invalidate("auth.sessions");
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
      invalidate("auth.sessions");
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
        title="Sessions / Devices"
        subtitle="Devices currently signed in to your Peridot ID."
      />

      {error && <p role="alert" style={s.error}>{error}</p>}

      {sessions.length > 1 && (
        <UIButton title={busy ? "Signing out…" : "Sign out other sessions"} onPress={revokeAllOthers} disabled={busy} />
      )}

      {sessions.map((se) => (
        <div key={se.id} style={s.card} className="flex flex-col">
          <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3">
            <div className="flex flex-col flex h-9 w-9 items-center justify-center rounded-full bg-muted">
              <Monitor size={16} className="text-foreground" />
            </div>
            <div className="flex flex-col flex-1 gap-0.5">
              <span className="font-sans text-sm font-semibold text-foreground">
                {se.userAgent ?? "Unknown device"}
                {se.isCurrent ? "  ·  this device" : ""}
              </span>
              <span className="font-sans text-xs text-muted-foreground">Signed in {fmtDate(se.createdAt)}</span>
              <span className="font-sans text-xs text-muted-foreground">Seen {se.lastSeenAt ? fmtDate(se.lastSeenAt) : "—"} · Expires {fmtDate(se.expiresAt)}</span>
            </div>
            {!se.isCurrent && (
              <Pressable onPress={() => revoke(se.id)} disabled={busy} accessibilityLabel="Sign out session">
                <div className="flex flex-col p-2">
                  <LogOut size={16} className="text-danger" />
                </div>
              </Pressable>
            )}
          </div>
        </div>
      ))}

      {sessions.length === 0 && <p style={s.hint}>No active sessions.</p>}
    </ScrollArea>
  );
}
