import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "../shared/primitives";
import { ChevronRight, FlaskConical, KeyRound, Monitor, Link2, Check, Banknote, TriangleAlert } from "../shared/icons";
import type { Authority, IdentityCredential } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { BackButton } from "../shared/components/BackButton";
import { CURRENCIES, getCurrency, setCurrency, type Currency } from "../shared/currency";
import { setNetworkMode } from "../shared/network-mode";
import { useNetworkMode } from "../shared/hooks/useNetworkMode";

interface Props {
  goPasskeys: () => void;
  goSessions: () => void;
  goConnected: () => void;
  onDone: () => void;
}

export function SettingsScreen({ goPasskeys, goSessions, goConnected, onDone }: Props) {
  const { peridot } = usePeridot();
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [credentials, setCredentials] = useState<IdentityCredential[]>([]);
  const [sessions, setSessions] = useState<unknown[]>([]);
  const [currency, setCurrencyState] = useState<Currency>(getCurrency);

  const load = useCallback(async () => {
    const [pk, creds, sess] = await Promise.all([
      peridot.passkey.list().catch(() => []),
      peridot.identity.credentials().catch(() => []),
      peridot.auth.sessions().catch(() => []),
    ]);
    setPasskeys(Array.isArray(pk) ? (pk as Authority[]) : []);
    setCredentials(Array.isArray(creds) ? (creds as IdentityCredential[]) : []);
    setSessions(Array.isArray(sess) ? (sess as unknown[]) : []);
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
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 10 }}>
      <BackButton onPress={onDone} />

      <Text style={s.title}>Settings</Text>

      <Text className="mt-4 font-sans text-xs font-semibold uppercase tracking-[0.6px] text-muted-foreground">Security</Text>
      <Row icon={KeyRound} label="Passkeys" value={`${passkeys.length} active`} onPress={goPasskeys} />
      <Row icon={Link2} label="Recovery" value={google ? "Google · Connected" : "Add Google"} onPress={goConnected} />
      <Row icon={Monitor} label="Sessions / Devices" value={`${sessions.length} active`} onPress={goSessions} />

      <Text className="mt-4 font-sans text-xs font-semibold uppercase tracking-[0.6px] text-muted-foreground">Network</Text>
      {net.testnet && (
        <View style={{ flexDirection: "row" }} className="items-start gap-3 border border-border bg-muted p-3.5">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-foreground" />
          <View className="flex-1 gap-1">
            <Text className="font-sans text-[13px] font-semibold text-foreground">TESTNET — not real money</Text>
            <Text className="font-sans text-[13px] leading-5 text-muted-foreground">
              Balances are testnet-only and separate from mainnet. Fiat top-ups and transfers are disabled; explorer links carry ?cluster=devnet.
            </Text>
          </View>
        </View>
      )}
      <TouchableOpacity
        onPress={toggleNetwork}
        disabled={net.switching}
        accessibilityRole="switch"
        accessibilityState={{ checked: net.testnet }}
        accessibilityLabel="Testnet Mode"
      >
        <View style={{ flexDirection: "row" }} className="w-full items-center gap-3 border border-border bg-surface p-3.5">
          <View className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-muted">
            <FlaskConical size={18} className="text-foreground" />
          </View>
          <View className="flex-1 gap-0.5">
            <Text className="font-sans text-[15px] font-medium text-foreground">Testnet Mode</Text>
            <Text className="font-sans text-[12px] text-muted-foreground">
              {net.switching ? "Switching network…" : net.testnet ? "On — using testnet chain" : "Off — using mainnet"}
            </Text>
          </View>
          <View
            style={{ flexDirection: "row" }}
            className={`items-center gap-1 border px-2.5 py-1.5 ${net.testnet ? "border-foreground" : "border-border"}`}
          >
            {net.testnet && <Check size={14} className="text-foreground" />}
            <Text className={`font-sans text-[13px] font-medium ${net.testnet ? "text-foreground" : "text-muted-foreground"}`}>
              {net.switching ? "…" : net.testnet ? "ON" : "OFF"}
            </Text>
          </View>
        </View>
      </TouchableOpacity>

      <Text className="mt-4 font-sans text-xs font-semibold uppercase tracking-[0.6px] text-muted-foreground">Preferences</Text>
      <View style={{ flexDirection: "row" }} className="items-center gap-2 border border-border bg-surface p-3.5">
        <View className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-muted">
          <Banknote size={18} className="text-foreground" />
        </View>
        <Text className="flex-1 font-sans text-[15px] font-medium text-foreground">Currency</Text>
        {CURRENCIES.map((c) => (
          <TouchableOpacity
            key={c}
            onPress={() => pickCurrency(c)}
            accessibilityState={{ selected: currency === c }}
          >
            <View style={{ flexDirection: "row" }} className={`items-center gap-1 border px-2.5 py-1.5 ${currency === c ? "border-foreground" : "border-border"}`}>
              {currency === c && <Check size={14} className="text-foreground" />}
              <Text className={`font-sans text-[13px] font-medium ${currency === c ? "text-foreground" : "text-muted-foreground"}`}>{c}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
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
    <TouchableOpacity onPress={onPress}>
      <View style={{ flexDirection: "row" }} className="w-full items-center gap-3 border border-border bg-surface p-3.5">
        <View className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-muted">
          <Icon size={18} className="text-foreground" />
        </View>
        <Text className="flex-1 font-sans text-[15px] font-medium text-foreground">{label}</Text>
        {value && <Text className="font-sans text-[13px] text-muted-foreground">{value}</Text>}
        <ChevronRight size={16} className="text-muted-foreground" />
      </View>
    </TouchableOpacity>
  );
}
