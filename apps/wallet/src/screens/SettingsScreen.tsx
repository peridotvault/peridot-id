import { useCallback, useEffect, useState } from "react";
import { ScrollArea } from "../shared/components/ScrollArea";
import { Pressable } from "../shared/components/Pressable";
import { ChevronRight, FlaskConical, KeyRound, Monitor, Link2, Check, Banknote, TriangleAlert } from "../shared/icons";
import type { Authority, IdentityCredential } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { cachedRead } from "../shared/api-cache";
import { styles as s } from "../shared/theme";
import { BackButton } from "../shared/components/BackButton";
import { UIButton } from "../shared/components/UIButton";
import { CURRENCIES, getCurrency, setCurrency, type Currency } from "../shared/currency";
import { setNetworkMode } from "../shared/network-mode";
import { useNetworkMode } from "../shared/hooks/useNetworkMode";

interface Props {
  goPasskeys: () => void;
  goSessions: () => void;
  goConnected: () => void;
  goAppConnections: () => void;
  onDone: () => void;
  onLogout: () => void;
  /** Rendered as the Settings tab root: no back button (nothing to pop). */
  tabRoot?: boolean;
}

export function SettingsScreen({ goPasskeys, goSessions, goConnected, goAppConnections, onDone, onLogout, tabRoot = false }: Props) {
  const { peridot } = usePeridot();
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [credentials, setCredentials] = useState<IdentityCredential[]>([]);
  const [sessions, setSessions] = useState<unknown[]>([]);
  const [currency, setCurrencyState] = useState<Currency>(getCurrency);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // ANT-333: surface fetch failures instead of silently swallowing them —
    // the rows below show whatever loaded, plus a retryable error banner.
    setLoadError(null);
    const wrap = async <T,>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
      try {
        return { ok: true, value: await p };
      } catch {
        return { ok: false };
      }
    };
    // Shared 30s read cache: Sessions/Passkey/Connected screens reuse these
    // exact keys, so opening them right after Settings costs nothing.
    const [pk, creds, sess] = await Promise.all([
      wrap(cachedRead("passkey.list", { ttlMs: 60_000, tier: "session" }, () => peridot.passkey.list())),
      wrap(cachedRead("identity.credentials", { ttlMs: 60_000, tier: "session" }, () => peridot.identity.credentials())),
      wrap(cachedRead("auth.sessions", { ttlMs: 60_000, tier: "session" }, () => peridot.auth.sessions())),
    ]);
    setPasskeys(pk.ok && Array.isArray(pk.value) ? (pk.value as Authority[]) : []);
    setCredentials(creds.ok && Array.isArray(creds.value) ? (creds.value as IdentityCredential[]) : []);
    setSessions(sess.ok && Array.isArray(sess.value) ? (sess.value as unknown[]) : []);
    const failed: string[] = [];
    if (!pk.ok) failed.push("passkeys");
    if (!creds.ok) failed.push("credentials");
    if (!sess.ok) failed.push("sessions");
    if (failed.length > 0) {
      setLoadError(`Couldn't load ${failed.join(", ")} — showing what's available. Retry to refresh.`);
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const google = credentials.find((c) => c.provider === "google");

  const pickCurrency = useCallback((c: Currency) => {
    setCurrencyState(c);
    setCurrency(c);
  }, []);

  // Server-driven testnet (ANT-15): the API registry stays the source of
  // truth per selection; the wallet persists the choice, re-fetches
  // selection-scoped data via the store subscription, and blocks signing
  // while the switch propagates. NO toggle lives in the account-switch
  // modal — Settings is the only place.
  const net = useNetworkMode();
  const toggleNetwork = useCallback(() => {
    if (net.switching) return;
    setNetworkMode(net.mode === "testnet" ? "mainnet" : "testnet");
  }, [net.mode, net.switching]);

  return (
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 10 }}>
      {!tabRoot && <BackButton onPress={onDone} />}

      <h1 style={s.title}>Settings</h1>

      {loadError && (
        <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3 border border-danger bg-surface p-3.5">
          <p role="alert" style={s.error} className="flex-1">
            {loadError}
          </p>
          <Pressable onPress={load} accessibilityRole="button" accessibilityLabel="Retry loading settings">
            <div className="flex flex-col border border-border px-2.5 py-1.5">
              <span className="font-sans text-sm font-medium text-foreground">Retry</span>
            </div>
          </Pressable>
        </div>
      )}

      <span className="mt-4 font-sans text-xs font-semibold uppercase tracking-[0.6px] text-muted-foreground">Security</span>
      <Row icon={Link2} label="App connections" value="Manage" onPress={goAppConnections} />
      <Row icon={KeyRound} label="Passkeys" value={`${passkeys.length} active`} onPress={goPasskeys} />
      <Row icon={Link2} label="Recovery" value={google ? "Google · Connected" : "Add Google"} onPress={goConnected} />
      <Row icon={Monitor} label="Sessions / Devices" value={`${sessions.length} active`} onPress={goSessions} />

      <span className="mt-4 font-sans text-xs font-semibold uppercase tracking-[0.6px] text-muted-foreground">Network</span>
      {net.testnet && (
        <div style={{ flexDirection: "row" }} className="flex flex-col items-start gap-3 border border-border bg-muted p-3.5">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-foreground" />
          <div className="flex flex-col flex-1 gap-1">
            <span className="font-sans text-sm font-semibold text-foreground">TESTNET — not real money</span>
            <span className="font-sans text-sm leading-5 text-muted-foreground">
              Balances are testnet-only and separate from mainnet. Fiat top-ups and transfers are disabled; explorer links carry ?cluster=devnet.
            </span>
          </div>
        </div>
      )}
      <Pressable
        onPress={toggleNetwork}
        disabled={net.switching}
        accessibilityRole="switch"
        accessibilityState={{ checked: net.testnet }}
        accessibilityLabel="Testnet Mode"
      >
        <div style={{ flexDirection: "row" }} className="flex flex-col w-full items-center gap-3 border border-border bg-surface p-3.5">
          <div className="flex flex-col flex h-[34px] w-[34px] items-center justify-center rounded-full bg-muted">
            <FlaskConical size={18} className="text-foreground" />
          </div>
          <div className="flex flex-col flex-1 gap-0.5">
            <span className="font-sans text-base font-medium text-foreground">Testnet Mode</span>
            <span className="font-sans text-xs text-muted-foreground">
              {net.switching ? "Switching network…" : net.testnet ? "On — using testnet chain" : "Off — using mainnet"}
            </span>
          </div>
          <div
            style={{ flexDirection: "row" }}
            className={`flex flex-col items-center gap-1 border px-2.5 py-1.5 ${net.testnet ? "border-foreground" : "border-border"}`}
          >
            {net.testnet && <Check size={14} className="text-foreground" />}
            <span className={`font-sans text-sm font-medium ${net.testnet ? "text-foreground" : "text-muted-foreground"}`}>
              {net.switching ? "…" : net.testnet ? "ON" : "OFF"}
            </span>
          </div>
        </div>
      </Pressable>

      <span className="mt-4 font-sans text-xs font-semibold uppercase tracking-[0.6px] text-muted-foreground">Preferences</span>
      {/* flexWrap: at 320px the two currency pills drop below the label instead of squeezing. */}
      <div style={{ flexDirection: "row", flexWrap: "wrap" }} className="flex flex-col items-center gap-2 border border-border bg-surface p-3.5">
        <div className="flex flex-col flex h-[34px] w-[34px] items-center justify-center rounded-full bg-muted">
          <Banknote size={18} className="text-foreground" />
        </div>
        <span className="flex-1 font-sans text-base font-medium text-foreground">Currency</span>
        {CURRENCIES.map((c) => (
          <Pressable
            key={c}
            onPress={() => pickCurrency(c)}
            accessibilityState={{ selected: currency === c }}
          >
            <div style={{ flexDirection: "row" }} className={`flex flex-col items-center gap-1 border px-2.5 py-1.5 ${currency === c ? "border-foreground" : "border-border"}`}>
              {currency === c && <Check size={14} className="text-foreground" />}
              <span className={`font-sans text-sm font-medium ${currency === c ? "text-foreground" : "text-muted-foreground"}`}>{c}</span>
            </div>
          </Pressable>
        ))}
      </div>

      <span className="mt-4 font-sans text-xs font-semibold uppercase tracking-[0.6px] text-muted-foreground">Account</span>
      <UIButton title="Sign Out" onPress={onLogout} variant="danger" />
    </ScrollArea>
  );
}

function Row({
  icon: Icon,
  label,
  value,
  onPress,
}: {
  icon: typeof KeyRound;
  label: string;
  value?: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} accessibilityLabel={label}>
      <div style={{ flexDirection: "row" }} className="flex flex-col w-full items-center gap-3 border border-border bg-surface p-3.5">
        <div className="flex flex-col flex h-[34px] w-[34px] items-center justify-center rounded-full bg-muted">
          <Icon size={18} className="text-foreground" />
        </div>
        <span className="flex-1 font-sans text-base font-medium text-foreground">{label}</span>
        {value && <span className="font-sans text-sm text-muted-foreground">{value}</span>}
        <ChevronRight size={16} className="text-muted-foreground" />
      </div>
    </Pressable>
  );
}
