import { useCallback, useEffect, useState } from "react";
import { Pressable } from "../../shared/components/ui/Pressable";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { Link2 } from "../../shared/components/icons";
import type { SsoGrant } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { cachedRead, invalidate } from "../../shared/data/apiCache";
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
    <div className="flex flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <PushHeader
            onBack={onDone}
            title="App Connections"
            subtitle="Sites you signed in to with PeridotID. Disconnecting stops future sign-ins there."
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
        {justRevoked && <span className="block px-6 py-3 font-sans text-sm text-success">Site disconnected.</span>}

        <div className="flex flex-col divide-y divide-line">
          {grants.map((g) => {
            const host = hostOf(g.origin);
            const label = g.name ?? host;
            return (
              <div key={g.id} className="flex items-center gap-3 px-6 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface">
                  <Link2 size={16} className="text-foreground" />
                </div>
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="font-sans text-base font-semibold text-foreground" aria-label={`${label}${g.isVerified ? ", verified" : ""}`}>
                    {label}
                    {g.isVerified && <span aria-hidden="true"> ✓</span>}
                  </span>
                  {g.name && <span className="font-sans text-xs text-muted-foreground">{host}</span>}
                  <span className="font-sans text-xs text-muted-foreground">Connected {fmtDate(g.firstSeenAt)}</span>
                  <span className="font-sans text-xs text-muted-foreground">Last used {fmtDate(g.lastUsedAt)}</span>
                </div>
                <Pressable onPress={() => disconnect(g.id, label)} disabled={busy} accessibilityLabel={`Disconnect ${label}`}>
                  <span className="p-2 font-sans text-sm text-danger">Disconnect</span>
                </Pressable>
              </div>
            );
          })}
        </div>

        {grants.length === 0 && <p style={s.hint} className="px-6 py-3">No connected sites yet.</p>}
      </Section>
    </div>
  );
}
