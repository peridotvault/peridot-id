import { useCallback, useEffect, useState } from "react";
import { Pressable } from "../../shared/components/ui/Pressable";
import { Section, SectionHead } from "../../shared/components/ui/Section";
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

/** `dashboard` → "Dashboard"; a wallet session has no scope. */
function scopeLabel(scope?: string | null): string {
  if (!scope) return "PeridotID wallet";
  return scope.charAt(0).toUpperCase() + scope.slice(1);
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
    <div className="flex flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <PushHeader
            onBack={onDone}
            title="Sessions / Devices"
            subtitle="Devices currently signed in to your Peridot ID."
          />
        </SectionHead>
      </Section>

      {error && (
        <Section className="border-t-danger/40 bg-danger/10">
          <SectionHead className="py-3">
            <p role="alert" className="font-sans text-sm text-foreground">{error}</p>
          </SectionHead>
        </Section>
      )}

      <Section>
        {sessions.length > 1 && (
          <div className="px-6 py-3">
            <UIButton title={busy ? "Signing out…" : "Sign out other sessions"} onPress={revokeAllOthers} disabled={busy} />
          </div>
        )}

        <div className="flex flex-col divide-y divide-line">
          {sessions.map((se) => (
            <div key={se.id} className="flex items-center gap-3 px-6 py-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface">
                <Monitor size={16} className="text-foreground" />
              </div>
              <div className="flex flex-1 flex-col gap-0.5">
                <span className="font-sans text-sm font-semibold text-foreground">
                  {scopeLabel(se.scope)}
                  {se.isCurrent ? "  ·  this device" : ""}
                </span>
                <span className="font-sans text-xs text-muted-foreground">{se.userAgent ?? "Unknown device"}</span>
                <span className="font-sans text-xs text-muted-foreground">Signed in {fmtDate(se.createdAt)}</span>
                <span className="font-sans text-xs text-muted-foreground">Seen {se.lastSeenAt ? fmtDate(se.lastSeenAt) : "—"} · Expires {fmtDate(se.expiresAt)}</span>
              </div>
              {!se.isCurrent && (
                <Pressable onPress={() => revoke(se.id)} disabled={busy} accessibilityLabel="Sign out session">
                  <div className="flex p-3">
                    <LogOut size={16} className="text-danger" />
                  </div>
                </Pressable>
              )}
            </div>
          ))}
        </div>

        {sessions.length === 0 && <p style={s.hint} className="px-6 py-3">No active sessions.</p>}
      </Section>
    </div>
  );
}
