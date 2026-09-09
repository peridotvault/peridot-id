import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Check } from "lucide-react-native";
import QRCode from "react-native-qrcode-svg";
import type { Account } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

export function ReceiveScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [address, setAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    let acc = await peridot.wallet.me();
    if ("statusCode" in acc) acc = await peridot.wallet.createAccount();
    if ("statusCode" in acc) return;
    const smart = (acc as Account).chainAccounts?.find((c) => c.accountType === "smart_account");
    setAddress(smart?.address ?? null);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — nothing to do
    }
  };

  return (
    <View style={s.container}>
      <Text style={s.title}>Receive</Text>
      <Text style={s.subtitle}>Share your smart account address to receive SOL or tokens.</Text>

      <View style={styles.qrWrap}>
        {address ? (
          <QRCode value={`solana:${address}`} size={200} backgroundColor={theme.colors.foreground} color={theme.colors.background} />
        ) : (
          <Text style={s.hint}>Account not initialized.</Text>
        )}
      </View>

      <TouchableOpacity style={styles.addressBox} onPress={copy}>
        <Text selectable style={s.mono}>{address ?? "—"}</Text>
        {copied && <Check size={16} color={theme.colors.success} />}
      </TouchableOpacity>
      {copied && <Text style={styles.copied}>Copied to clipboard</Text>}

      <UIButton title="Back" onPress={onDone} />
    </View>
  );
}

const styles = StyleSheet.create({
  qrWrap: {
    alignSelf: "center",
    padding: 16,
    backgroundColor: theme.colors.foreground,
    borderRadius: 0,
    marginTop: 16,
  },
  addressBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    borderRadius: 0,
  },
  copied: { color: theme.colors.success, fontSize: 13, textAlign: "center", fontFamily: theme.fonts.sans },
});