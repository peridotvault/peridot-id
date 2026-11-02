import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable } from "../../shared/components/ui/Pressable";
import { ChevronRight, FlaskConical, KeyRound, Monitor, Link2, Check, Banknote, TriangleAlert, LayoutGrid } from "../../shared/components/icons";
import type { Authority, IdentityCredential } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { cachedRead } from "../../shared/data/apiCache";
import { styles as s } from "../../shared/styles/theme";
import { BackButton } from "../../shared/components/ui/BackButton";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { UIButton } from "../../shared/components/ui/UIButton";
import { CURRENCIES, getCurrency, setCurrency, type Currency } from "../../shared/data/currency";
import { setNetworkMode } from "../../shared/data/networkMode";
import { useNetworkMode } from "../../shared/hooks/useNetworkMode";
import { isChainSelected } from "../../shared/data/selectedChains";
import { useSelectedChains } from "../../shared/hooks/useSelectedChains";

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

export function Settings({ goPasskeys, goSessions, goConnected, goAppConnections, onDone, onLogout, tabRoot = false }: Props) {
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

  // ANT-625 chain selection (FR1): master All-chains row + one row per
  // GET /v1/chains row. Toggles write the selectedChains store (same
  // signing-block + failsafe as a network switch); data hooks reload on the
  // subscription. pid_network_mode is untouched.
  const sel = useSelectedChains();
  const toggleMaster = useCallback(() => {
    if (net.switching) return;
    if (sel.selection.mode === "all") {
      // Custom covering every known row: no visible change, and the user
      // can now deselect rows one by one. Refresh first when rows are
      // still loading so the set is built from live registry data.
      if (sel.chains.length === 0) {
        sel.retryChains();
        return;
      }
      sel.setCustom(sel.chains.map((c) => ({ namespace: c.namespace, reference: c.reference })));
    } else {
      sel.setAll();
    }
  }, [net.switching, sel]);

  return (
    <div className="flex flex-col">
      {!tabRoot && (
        <Section className="border-t-0">
          <SectionHead className="pb-0 pt-4">
            <BackButton onPress={onDone} />
          </SectionHead>
        </Section>
      )}

      <Section className={tabRoot ? "border-t-0" : ""}>
        <SectionHead>
          <h1 style={s.title}>Settings</h1>
        </SectionHead>
      </Section>

      {loadError && (
        <Section className="border-t-danger/40 bg-danger/10">
          <SectionHead className="py-3">
            <p role="alert" className="font-sans text-sm text-foreground">{loadError}</p>
            <Retry onPress={load} label="Retry loading settings" />
          </SectionHead>
        </Section>
      )}

      <Group title="Security">
        <Row icon={Link2} label="App connections" value="Manage" onPress={goAppConnections} />
        <Row icon={KeyRound} label="Passkeys" value={`${passkeys.length} active`} onPress={goPasskeys} />
        <Row icon={Link2} label="Recovery" value={google ? "Google · Connected" : "Add Google"} onPress={goConnected} />
        <Row icon={Monitor} label="Sessions / Devices" value={`${sessions.length} active`} onPress={goSessions} />
      </Group>

      {net.testnet && (
        <Section className="border-t-secondary bg-secondary">
          <SectionHead className="py-3">
            <div className="flex items-start gap-3">
              <TriangleAlert size={18} className="mt-0.5 shrink-0 text-foreground" />
              <div className="flex flex-1 flex-col gap-1">
                <span className="font-sans text-sm font-semibold text-foreground">TESTNET — not real money</span>
                <span className="font-sans text-sm leading-5 text-foreground">
                  Balances are testnet-only and separate from mainnet. Fiat top-ups and transfers are disabled; explorer links carry ?cluster=devnet.
                </span>
              </div>
            </div>
          </SectionHead>
        </Section>
      )}

      <Group title="Network">
        <ToggleRow
          icon={FlaskConical}
          label="Testnet Mode"
          hint={net.switching ? "Switching network…" : net.testnet ? "On — using testnet chain" : "Off — using mainnet"}
          on={net.testnet}
          busy={net.switching}
          onPress={toggleNetwork}
        />
      </Group>

      {/* ANT-625 FR1: Chains group — master All-chains row + one row per
          GET /v1/chains row (name + testnet badge + toggle). Toggles are
          disabled while a network/selection switch propagates. */}
      <Group title="Chains">
        <p className="px-6 py-3 font-sans text-xs text-muted-foreground">
          {sel.selection.mode === "all"
            ? "Showing all chains — data loads for every available chain."
            : `Showing ${sel.label} — data loads only for selected chains.`}
        </p>

        {sel.notice && (
          <Pressable onPress={sel.dismissNotice} accessibilityRole="button" accessibilityLabel="Dismiss chain notice">
            <span role="status" className="block px-6 py-3 font-sans text-sm text-muted-foreground">{sel.notice}</span>
          </Pressable>
        )}

        <ToggleRow
          icon={LayoutGrid}
          label="All chains"
          hint={net.switching ? "Switching…" : sel.selection.mode === "all" ? "On — using every chain" : "Off — custom selection below"}
          on={sel.selection.mode === "all"}
          busy={net.switching}
          onPress={toggleMaster}
        />

        {sel.chainsError && (
          <div className="px-6 py-3">
            <span role="alert" className="font-sans text-sm text-muted-foreground">
              Couldn&apos;t load the chain list ({sel.chainsError}) — showing your saved selection. Retry to refresh.
            </span>
            <Retry onPress={sel.retryChains} label="Retry loading chains" />
          </div>
        )}

        {sel.chains.length === 0 && !sel.chainsError && (
          <span role="status" className="block px-6 py-3 font-sans text-sm text-muted-foreground">Loading chains…</span>
        )}

        {sel.chains.map((c) => {
          const on = isChainSelected(sel.selection, c.namespace, c.reference);
          return (
            <ToggleRow
              key={`${c.namespace}:${c.reference}`}
              icon={LayoutGrid}
              label={c.name}
              hint={`${c.namespace}:${c.reference.slice(0, 8)}${c.reference.length > 8 ? "…" : ""}`}
              testnet={c.isTestnet}
              on={on}
              busy={net.switching}
              onPress={() => sel.toggle(c.namespace, c.reference)}
            />
          );
        })}
      </Group>

      <Group title="Preferences">
        {/* flexWrap: at 320px the two currency pills drop below the label instead of squeezing. */}
        <div className="flex flex-wrap items-center gap-3 px-6 py-3">
          <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-line bg-surface">
            <Banknote size={18} className="text-foreground" />
          </div>
          <span className="flex-1 font-sans text-base font-medium text-foreground">Currency</span>
          {CURRENCIES.map((c) => (
            <Pressable
              key={c}
              onPress={() => pickCurrency(c)}
              accessibilityState={{ selected: currency === c }}
            >
              <div className={`flex items-center gap-1 border px-2.5 py-1.5 ${currency === c ? "border-foreground" : "border-border"}`}>
                {currency === c && <Check size={14} className="text-foreground" />}
                <span className={`font-sans text-sm font-medium ${currency === c ? "text-foreground" : "text-muted-foreground"}`}>{c}</span>
              </div>
            </Pressable>
          ))}
        </div>
      </Group>

      <Section>
        <SectionHead className="pb-8">
          <UIButton title="Sign Out" onPress={onLogout} variant="danger" />
        </SectionHead>
      </Section>
    </div>
  );
}

// One titled block: the heading sits on the section rule, rows are dividers.
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section>
      <SectionHead className="pb-0 pt-4">
        <span className="font-sans text-xs font-semibold uppercase tracking-[0.6px] text-muted-foreground">{title}</span>
      </SectionHead>
      <div className="flex flex-col divide-y divide-line">{children}</div>
    </Section>
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
      <div className="flex w-full items-center gap-3 px-6 py-3 transition-colors hover:bg-surface">
        <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-line bg-surface">
          <Icon size={18} className="text-foreground" />
        </div>
        <span className="flex-1 font-sans text-base font-medium text-foreground">{label}</span>
        {value && <span className="font-sans text-sm text-muted-foreground">{value}</span>}
        <ChevronRight size={16} className="text-muted-foreground" />
      </div>
    </Pressable>
  );
}

function ToggleRow({
  icon: Icon,
  label,
  hint,
  on,
  busy,
  testnet,
  onPress,
}: {
  icon: typeof KeyRound;
  label: string;
  hint: string;
  on: boolean;
  busy?: boolean;
  testnet?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={testnet ? `${label} (testnet)` : label}
    >
      <div className="flex w-full items-center gap-3 px-6 py-3 transition-colors hover:bg-surface">
        <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-line bg-surface">
          <Icon size={18} className="text-foreground" />
        </div>
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="font-sans text-base font-medium text-foreground">{label}</span>
          <span className="font-sans text-xs text-muted-foreground">{hint}</span>
        </div>
        {testnet && <span className="font-sans text-xs font-bold tracking-[1px] text-muted-foreground">TESTNET</span>}
        <div className={`flex items-center gap-1 border px-2.5 py-1.5 ${on ? "border-foreground" : "border-border"}`}>
          {on && <Check size={14} className="text-foreground" />}
          <span className={`font-sans text-sm font-medium ${on ? "text-foreground" : "text-muted-foreground"}`}>
            {busy ? "…" : on ? "ON" : "OFF"}
          </span>
        </div>
      </div>
    </Pressable>
  );
}

function Retry({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <div className="mt-2 flex items-center self-start border-b border-foreground py-1">
        <span className="font-sans text-sm font-medium text-foreground">Retry</span>
      </div>
    </Pressable>
  );
}
