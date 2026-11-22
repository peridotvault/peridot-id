import { Pressable } from "../../../shared/components/ui/Pressable";
import { BottomSheet } from "../../../shared/components/ui/BottomSheet";
import { Section, SectionHead } from "../../../shared/components/ui/Section";
import { TextField } from "../../../shared/components/ui/TextField";
import { styles as s } from "../../../shared/styles/theme";
import { AsciiRidges } from "../../../shared/components/ui/AsciiRidges";
import { BrandMark } from "../../../shared/components/ui/BrandMark";
import { UIButton } from "../../../shared/components/ui/UIButton";
import { ArrowRight, Mail, Wallet } from "../../../shared/components/icons";
import { detectWallets, discoverWallets, type WalletConnector } from "@peridotvault/pid-sdk-js";
import { useEffect, useMemo, useState } from "react";
import type { CatalogProvider } from "../hooks/useProviderCatalog";

/** Catalogue icon with fallback; never renders catalogue SVG/HTML. */
function CatalogIcon({ provider, fallback }: { provider: CatalogProvider; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (!provider.imageUrl || failed) return <>{fallback}</>;
  return (
    <img
      src={provider.imageUrl}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      crossOrigin="anonymous"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="object-contain"
    />
  );
}

// Brand glyphs (Google "G") — inline SVG, the only brand mark in the wallet.
// lucide ships no brand icons; one tiny path set beats a whole icon-font
// dependency.
function GoogleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

// Default login form: inline email / Google / wallet / passkey + legal line.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i;
export function LoginOptions({
  busy,
  error,
  stepUp,
  ssoOrigin,
  ctxOrigin,
  allowedMethods,
  catalog = null,
  email,
  onGoogle,
  onEmailChange,
  onSubmitEmail,
  onPasskey,
  onWallet,
}: {
  busy: boolean;
  error: string | null;
  stepUp: boolean;
  ssoOrigin: string | null;
  ctxOrigin: string | null;
  /** App-enabled login methods; null/undefined = all on. */
  allowedMethods: string[] | null;
  /** Platform catalogue; null = not loaded (fall back to app switches). */
  catalog?: CatalogProvider[] | null;
  email: string;
  onGoogle: () => void;
  onEmailChange: (t: string) => void;
  onSubmitEmail: () => void;
  onPasskey: () => void;
  onWallet: (wallet: WalletConnector) => void;
}) {
  // Discovery runs once per mount and also over EIP-6963, so MetaMask is found
  // even when the browser's own wallet answers on `window.ethereum`.
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
  const [walletSheet, setWalletSheet] = useState(false);
  const byCode = useMemo(() => new Map((catalog ?? []).map((p) => [p.code, p])), [catalog]);
  // Catalogue known ⇒ only ready + globally enabled providers are offered; an
  // app switch never re-enables a disabled provider. Catalogue unknown ⇒ keep
  // the app's switches (the API still rejects unavailable providers).
  const allows = (m: string) => {
    if (allowedMethods && !allowedMethods.includes(m)) return false;
    if (!catalog) return true;
    const provider = byCode.get(m);
    return Boolean(provider?.isAvailable && provider.isSupported);
  };
  const google = byCode.get("google");
  // One row per wallet kind: Phantom injects both a Solana and an EVM provider,
  // and both carry kind "phantom" (the catalogue name would print it twice).
  const visibleWallets = wallets
    .filter((w) => allows(w.kind))
    .filter((w, i, all) => all.findIndex((x) => x.kind === w.kind) === i);
  // Shape check only (no API round-trip): the arrow stays disabled until the
  // address looks like `local@domain.tld`. The server stays the authority.
  const canSubmitEmail = !busy && EMAIL_RE.test(email.trim());
  const submitEmail = () => {
    if (canSubmitEmail) onSubmitEmail();
  };
  return (
    <div className="flex flex-col flex-1">
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <div className="flex flex-1 flex-col justify-center py-6">
      <Section className="border-t-0">
        <SectionHead className="flex flex-col gap-4 pb-8">
            <div className="flex flex-col flex-1 w-full items-center justify-center gap-5">
              <div className="flex flex-col items-center gap-2">
                <BrandMark size="lg" />
                {ssoOrigin ? (
                  <span className="font-sans text-sm text-muted-foreground">Sign in to continue to {ssoOrigin}</span>
                ) : ctxOrigin ? (
                  <span className="font-sans text-sm text-muted-foreground">Sign in to continue to {ctxOrigin}</span>
                ) : null}
              </div>
              {error && <p role="alert" style={s.error}>{error}</p>}
              <div className="flex flex-col w-full max-w-[343px] gap-3">
                {allows("email") && (
                  <div
                    onClick={() => document.getElementById("login-email-inline")?.focus()}
                    className="flex min-h-13 cursor-text items-center gap-2.5 rounded-lg border border-border bg-elevated px-5 focus-within:border-foreground"
                  >
                    <Mail size={16} className="shrink-0 text-muted-foreground" />
                    {/* outline-none! : base.css focus ring is unlayered, plain utilities lose to it */}
                    <TextField
                      id="login-email-inline"
                      aria-label="Email address"
                      className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-sm text-foreground [--placeholder:var(--color-muted-foreground)] outline-none!"
                      value={email}
                      onChangeText={onEmailChange}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                      returnKeyType="go"
                      placeholder="Continue with email"
                      editable={!busy}
                      onSubmitEditing={submitEmail}
                    />
                    <Pressable
                      onPress={submitEmail}
                      disabled={!canSubmitEmail}
                      accessibilityRole="button"
                      accessibilityLabel="Continue with email"
                      style={{ opacity: canSubmitEmail ? 1 : 0.4 }}
                      className="-mr-3 shrink-0 p-3 text-foreground disabled:cursor-default"
                    >
                      <ArrowRight size={18} />
                    </Pressable>
                  </div>
                )}
                {allows("google") && (
                  <UIButton
                    title={google?.name ? `Continue with ${google.name}` : "Continue with Google"}
                    onPress={onGoogle}
                    disabled={busy}
                    align="left"
                    icon={google ? <CatalogIcon provider={google} fallback={<GoogleIcon size={16} />} /> : <GoogleIcon size={16} />}
                  />
                )}
                {visibleWallets.length > 0 && (
                  <UIButton
                    title="Continue with Wallet"
                    onPress={() => setWalletSheet(true)}
                    disabled={busy}
                    align="left"
                    icon={<Wallet size={16} />}
                  />
                )}
                {allows("passkey") && (
                  <>
                    <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3">
                      <div className="flex flex-col h-px flex-1 bg-border"  />
                      <span className="font-sans text-xs text-muted-foreground">or</span>
                      <div className="flex flex-col h-px flex-1 bg-border"  />
                    </div>
                    {stepUp && (
                      <span className="text-center font-sans text-sm text-foreground">Session expired — please confirm it's you with your passkey.</span>
                    )}
                    <UIButton
                      title={busy ? "Waiting for passkey…" : "Select a passkey"}
                      onPress={onPasskey}
                      disabled={busy}
                      variant="primary"
                    />
                  </>
                )}
                <span className="text-center font-sans text-xs text-muted-foreground">By continuing, I agree to PeridotID Terms of Use and Privacy notice</span>
              </div>
            </div>
      
        </SectionHead>
      </Section>
    </div>
    <BottomSheet
      visible={walletSheet}
      title="Continue with Wallet"
      onClose={() => setWalletSheet(false)}
      center
      className="max-w-[343px] rounded-xl border-line bg-card"
    >
      <span className="font-sans text-xs text-muted-foreground">Pick a browser wallet to sign in.</span>
      <div className="flex flex-col gap-2">
        {visibleWallets.map((wallet) => (
          <UIButton
            key={`${wallet.kind}:${wallet.namespace}`}
            title={byCode.get(wallet.kind)?.name ?? wallet.label}
            onPress={() => {
              setWalletSheet(false);
              onWallet(wallet);
            }}
            disabled={busy}
            align="left"
            className="border-line bg-elevated hover:bg-muted"
          />
        ))}
      </div>
    </BottomSheet>
    </div>
  );
}
