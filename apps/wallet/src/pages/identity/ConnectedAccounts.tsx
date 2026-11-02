import { useCallback, useEffect, useState } from "react";
import { Pressable } from "../../shared/components/ui/Pressable";
import { Section, SectionHead } from "../../shared/components/ui/Section";
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
    <div className="flex flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <PushHeader
            onBack={onDone}
            title="Connected Accounts"
            subtitle="Login methods linked to this Peridot ID. Google is the fallback/recovery path for your passkeys."
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
        {justUnlinked && <span className="block px-6 py-3 font-sans text-sm text-success">Account unlinked.</span>}

        <div className="flex flex-col divide-y divide-line">
          {credentials.map((c) => (
            <div key={c.id} className="flex flex-col">
              <div className="flex items-center gap-3 px-6 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface">
                  <Link2 size={16} className="text-foreground" />
                </div>
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="font-sans text-base font-semibold text-foreground">{c.provider === "google" ? "Google" : c.provider}</span>
                  <span className="font-sans text-xs text-muted-foreground">{c.email ?? "No email"}</span>
                  {c.lastLoginAt && <span className="font-sans text-xs text-muted-foreground">Last login {new Date(c.lastLoginAt).toLocaleString()}</span>}
                </div>
                {credentials.length > 1 && (
                  <Pressable onPress={() => unlink(c.id, c.provider)} disabled={busy} accessibilityLabel={`Unlink ${c.provider}`}>
                    <span className="p-2 font-sans text-sm text-danger">Unlink</span>
                  </Pressable>
                )}
              </div>
              {credentials.length <= 1 && <span className="px-6 pb-3 font-sans text-xs text-muted-foreground">Keep at least one login method.</span>}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
