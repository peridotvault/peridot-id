import { useCallback, useEffect, useState } from "react";
import { Pressable } from "../../shared/components/ui/Pressable";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { KeyRound, Plus, Trash2 } from "../../shared/components/icons";
import type { Authority } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { cachedRead, invalidate } from "../../shared/data/apiCache";
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
    <div className="flex flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <PushHeader onBack={onDone} title="Passkeys" />
          <p style={s.subtitle} className="mt-2">
            Passkeys authorize your on-chain wallet (secp256r1). Register one on this device to
            sign in and authorize withdrawals. Your last passkey cannot be removed.
          </p>
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
        <div className="px-6 py-3">
          <UIButton
            title={busy ? "Waiting for passkey…" : "Add Passkey"}
            icon={<Plus size={16} className="text-foreground" />}
            onPress={register}
            disabled={busy}
          />
          {authorities.length > 0 && (
            <p style={s.hint} className="mt-3">One platform passkey per device — add extras from another device or a security key.</p>
          )}
        </div>

        <div className="flex flex-col divide-y divide-line">
          {authorities.map((a) => (
            <div key={a.id} className="flex flex-col">
              <div className="flex items-center gap-3 px-6 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface">
                  <KeyRound size={16} className="text-foreground" />
                </div>
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="font-sans text-base font-semibold text-foreground">Passkey</span>
                  <span className="font-sans text-xs text-muted-foreground">Added {fmtDate(a.createdAt)}</span>
                  <span className="font-sans text-xs text-muted-foreground">Last used {fmtDate(a.lastUsedAt)}</span>
                  {a.credentialId && (
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground" title={`ID ${a.credentialId}`}>
                      ID {a.credentialId}
                    </span>
                  )}
                </div>
                <Pressable
                  onPress={() => revoke(a.id)}
                  disabled={busy || onlyOne}
                  accessibilityLabel={`Remove passkey ${a.credentialId ?? a.id}`}
                >
                  <div className={`flex p-3 ${onlyOne ? "opacity-40" : ""}`}>
                    <Trash2 size={16} className={onlyOne ? "text-muted-foreground" : "text-danger"} />
                  </div>
                </Pressable>
              </div>
              {onlyOne && (
                <span className="px-6 pb-3 font-sans text-xs text-muted-foreground">This is your only passkey — keep it to stay able to sign in.</span>
              )}
            </div>
          ))}
        </div>

        {authorities.length === 0 && <p style={s.hint} className="px-6 py-3">No passkeys yet. Add one above.</p>}
      </Section>
    </div>
  );
}
