import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Check } from "../icons";
import QRCode from "react-native-qrcode-svg";
import type { Account } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

interface DepositTarget {
  key: string;
  label: string;
  sublabel: string;
  address: string;
  qrValue: string;
}

// ponytail: display names live here until the API exposes registry metadata to users.
const EVM_LABELS: Record<string, { label: string; asset: string }> = {
  "10143": { label: "Monad Testnet", asset: "MON" },
  "97": { label: "BNB Testnet", asset: "tBNB" },
  "421614": { label: "Arbitrum Sepolia", asset: "ETH" },
  "84532": { label: "Base Sepolia", asset: "ETH" },
};

export function ReceiveScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [targets, setTargets] = useState<DepositTarget[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    let acc = await peridot.wallet.me();
    if ("statusCode" in acc) acc = await peridot.wallet.createAccount();
    if ("statusCode" in acc) return;
    const rows = (acc as Account).chainAccounts?.filter((c) => c.accountType === "smart_account") ?? [];
    setTargets(
      rows.map((c, i) => {
        if (c.chainNamespace === "solana") {
          return {
            key: `solana-${i}`,
            label: "Solana",
            sublabel: "SOL or SPL tokens",
            address: c.address,
            qrValue: `solana:${c.address}`,
          };
        }
        const meta = EVM_LABELS[c.chainReference] ?? { label: `EVM ${c.chainReference}`, asset: "native" };
        return {
          key: `eip155-${c.chainReference}`,
          label: meta.label,
          sublabel: meta.asset,
          address: c.address,
          qrValue: c.address,
        };
      }),
    );
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const copy = async (key: string, address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // clipboard unavailable — nothing to do
    }
  };

  return (
    <View style={s.container}>
      <Text style={s.title}>Receive</Text>
      <Text style={s.subtitle}>Share an address below. EVM chains share one address everywhere.</Text>

      {targets.length === 0 && <Text style={s.hint}>Account not initialized.</Text>}

      {targets.map((t) => (
        <View key={t.key} style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.chainLabel}>{t.label}</Text>
            <Text style={s.hint}>{t.sublabel}</Text>
          </View>
          <View style={styles.qrWrap}>
            <QRCode value={t.qrValue} size={180} backgroundColor={theme.colors.foreground} color={theme.colors.background} />
          </View>
          <TouchableOpacity style={styles.addressBox} onPress={() => copy(t.key, t.address)}>
            <Text selectable style={s.mono}>{t.address}</Text>
            {copiedKey === t.key && <Check size={16} color={theme.colors.success} />}
          </TouchableOpacity>
          {copiedKey === t.key && <Text style={styles.copied}>Copied to clipboard</Text>}
        </View>
      ))}

      <UIButton title="Back" onPress={onDone} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    borderRadius: 0,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  chainLabel: { fontSize: 15, fontWeight: "600", fontFamily: theme.fonts.sans },
  qrWrap: {
    alignSelf: "center",
    padding: 12,
    backgroundColor: theme.colors.foreground,
    borderRadius: 0,
    marginBottom: 8,
  },
  addressBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    borderRadius: 0,
  },
  copied: { color: theme.colors.success, fontSize: 13, textAlign: "center", fontFamily: theme.fonts.sans },
});
