import { useCallback, useEffect, useState } from "react";
import { Pressable } from "../../shared/components/ui/Pressable";
import { ListRow, RowTile } from "../../shared/components/ui/ListRow";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { Link2 } from "../../shared/components/icons";
import type { IdentityCredential } from "@peridotvault/pid-types";
import { detectWallets, discoverWallets, type WalletConnector } from "@peridotvault/pid-sdk-js";
import { UIButton } from "../../shared/components/ui/UIButton";
import { usePeridot } from "../../shared/app/AppContext";
import { cachedRead, invalidate } from "../../shared/data/apiCache";
import { PushHeader } from "../../shared/components/ui/PushHeader";

export function ConnectedAccounts({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [credentials, setCredentials] = useState<IdentityCredential[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justUnlinked, setJustUnlinked] = useState(false);
  // External wallets are ordinary credentials (provider solana/evm) — the same
  // list, so one unlink path covers Google, email and wallets.
  const [wallets, setWallets] = useState<WalletConnector[]>(() => detectWallets());
  useEffect(() => {
    let alive = true;
    discoverWallets().then((found) => {
      if (alive) setWallets(found);
    });
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    const res = await cachedRead("identity.credentials", { ttlMs: 60_000, tier: "session" }, () => peridot.identity.credentials());
    setCredentials(Array.isArray(res) ? (res as IdentityCredential[]) : []);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const walletLabel = (provider: string): string =>
    provider === "google" ? "Google" : provider === "solana" ? "Solana wallet" : provider === "evm" ? "EVM wallet" : provider;

  /** Link a discovered wallet to this PID. The signature proves control; keys never leave the extension. */
  const link = async (wallet: WalletConnector) => {
    setBusy(true);
    setError(null);
    try {
      const address = await wallet.connect();
      const challenge = await peridot.auth.walletLinkChallenge({
        namespace: wallet.namespace,
        reference: wallet.reference,
        address,
      });
      const signature = await wallet.signMessage(address, challenge.message);
      await peridot.auth.walletLink(challenge.challengeId, signature);
      invalidate("identity.credentials");
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(/reject|denied|cancel|closed/i.test(message) ? "Signature cancelled — try again." : message);
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (id: string, provider: string) => {
    if (
      !window.confirm(
        `Unlink ${walletLabel(provider)}?\n\nGoogle works as a recovery login. Unlinking it means you rely on your passkeys to sign in.`,
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

      {wallets.length > 0 && (
        <Section>
          <SectionHead className="flex flex-col gap-2 py-3">
            <span className="font-sans text-xs text-muted-foreground">
              Link a wallet as another way to sign in. The wallet keeps its keys — signing only proves you own the address.
            </span>
            {wallets.map((wallet) => (
              <UIButton
                key={`${wallet.kind}:${wallet.namespace}`}
                title={`Link ${wallet.label}`}
                onPress={() => link(wallet)}
                disabled={busy}
                align="left"
              />
            ))}
          </SectionHead>
        </Section>
      )}

      <Section>
        {justUnlinked && <span className="block px-6 py-3 font-sans text-sm text-success">Account unlinked.</span>}

        <div className="flex flex-col divide-y divide-line">
          {credentials.map((c) => (
            <div key={c.id} className="flex flex-col">
              <ListRow hairline={false}>
                <RowTile>
                  <Link2 size={16} className="text-foreground" />
                </RowTile>
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="font-sans text-base font-semibold text-foreground">{walletLabel(c.provider)}</span>
                  <span className="font-sans text-xs text-muted-foreground">
                    {c.email ??
                      (c.providerUserId && c.providerUserId.length > 20
                        ? `${c.providerUserId.slice(0, 6)}…${c.providerUserId.slice(-6)}`
                        : (c.providerUserId ?? "No email"))}
                  </span>
                  {c.lastLoginAt && <span className="font-sans text-xs text-muted-foreground">Last login {new Date(c.lastLoginAt).toLocaleString()}</span>}
                </div>
                {credentials.length > 1 && (
                  <Pressable onPress={() => unlink(c.id, c.provider)} disabled={busy} accessibilityLabel={`Unlink ${c.provider}`}>
                    <span className="p-2 font-sans text-sm text-danger">Unlink</span>
                  </Pressable>
                )}
              </ListRow>
              {credentials.length <= 1 && <span className="px-6 pb-3 font-sans text-xs text-muted-foreground">Keep at least one login method.</span>}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
