import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable } from "../../shared/components/ui/Pressable";
import { ChevronRight, KeyRound, Monitor, Link2, Check, Banknote, LayoutGrid, Volume2, VolumeX } from "../../shared/components/icons";
import { isSoundOn, play, setSoundOn } from "../../shared/sfx/player";
import type { Authority, IdentityCredential } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { cachedRead } from "../../shared/data/apiCache";
import { BackButton } from "../../shared/components/ui/BackButton";
import { ListRow, RowTile } from "../../shared/components/ui/ListRow";
import { Label } from "../../shared/components/ui/Label";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { Retry } from "../../shared/components/ui/Retry";
import { ToggleRow } from "../../shared/components/ui/ToggleRow";
import { UIButton } from "../../shared/components/ui/UIButton";
import { CURRENCIES, getCurrency, setCurrency, type Currency } from "../../shared/data/currency";
import { useSelectedChains } from "../../shared/hooks/useSelectedChains";

interface Props {
  goChains: () => void;
  goPasskeys: () => void;
  goSessions: () => void;
  goConnected: () => void;
  goAppConnections: () => void;
  onDone: () => void;
  onLogout: () => void;
  /** Rendered as the Settings tab root: no back button (nothing to pop). */
  tabRoot?: boolean;
}

export function Settings({ goChains, goPasskeys, goSessions, goConnected, goAppConnections, onDone, onLogout, tabRoot = false }: Props) {
  const { peridot } = usePeridot();
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [credentials, setCredentials] = useState<IdentityCredential[]>([]);
  const [sessions, setSessions] = useState<unknown[]>([]);
  const [currency, setCurrencyState] = useState<Currency>(getCurrency);
  const [soundOn, setSoundState] = useState(isSoundOn);
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
    play("selected");
  }, []);

  const toggleSound = useCallback(() => {
    const next = !soundOn;
    setSoundState(next);
    setSoundOn(next);
    // Enabling is itself feedback; muting must stay silent.
    if (next) play("checked");
  }, [soundOn]);

  // Mainnet/Testnet are two API deployments (identity on mainnet, data per
  // network), so the toggle persists the choice and reloads into that
  // network's API. NO toggle lives in the account-switch modal — Settings is
  // the only place.
  // Chain selection lives on its own page (pages/identity/Chains); Settings
  // only shows the active selection label on the "Chains" row.
  const sel = useSelectedChains();

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
          <h1 className="text-xl font-semibold text-foreground">Settings</h1>
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

      <Group title="Network">
        <Row icon={LayoutGrid} label="Chains" value={sel.label} onPress={goChains} />
      </Group>


      <Group title="Preferences">
        <ToggleRow
          icon={soundOn ? Volume2 : VolumeX}
          label="Interface sounds"
          hint={soundOn ? "On — cues for outcomes, copies and toggles" : "Off — the wallet is silent"}
          on={soundOn}
          onPress={toggleSound}
        />
        {/* flexWrap: at 320px the two currency pills drop below the label instead of squeezing. */}
        <div className="flex flex-wrap items-center gap-3 px-6 py-3">
          <RowTile>
            <Banknote size={18} className="text-foreground" />
          </RowTile>
          <span className="flex-1 font-sans text-base font-medium text-foreground">Currency</span>
          {CURRENCIES.map((c) => (
            <Pressable
              key={c}
              onPress={() => pickCurrency(c)}
              accessibilityState={{ selected: currency === c }}
            >
              <div className={`flex items-center gap-1 rounded-md border px-2.5 py-1.5 ${currency === c ? "border-foreground" : "border-border"}`}>
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
        <Label className="font-semibold">{title}</Label>
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
    <ListRow onPress={onPress} accessibilityLabel={label} hairline={false}>
      <RowTile>
        <Icon size={18} className="text-foreground" />
      </RowTile>
      <span className="flex-1 font-sans text-base font-medium text-foreground">{label}</span>
      {value && <span className="font-sans text-sm text-muted-foreground">{value}</span>}
      <ChevronRight size={16} className="text-muted-foreground" />
    </ListRow>
  );
}


