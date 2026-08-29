import { useCallback, useEffect, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Account } from "@peridot/types";
import { usePeridot } from "../AppContext";

interface HomeScreenProps {
  goTopup: () => void;
  goWithdraw: () => void;
  goPasskey: () => void;
  onLogout: () => void;
}

export function HomeScreen({ goTopup, goWithdraw, goPasskey, onLogout }: HomeScreenProps) {
  const { peridot } = usePeridot();
  const [account, setAccount] = useState<Account | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      let acc = await peridot.wallet.me();
      if ("statusCode" in acc) {
        acc = await peridot.wallet.createAccount();
      }
      if ("statusCode" in acc) throw new Error("Gagal membuat akun");
      setAccount(acc as Account);
      try {
        setBalance(await peridot.wallet.getBalance());
      } catch {
        setBalance(0);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const smart = account?.chainAccounts?.find((c) => c.accountType === "smart_account");

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Wallet</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      {busy && <Text>Memuat...</Text>}
      {account && (
        <View style={styles.card}>
          <Text style={styles.label}>Alamat Akun Pintar</Text>
          <Text selectable style={styles.mono}>{smart?.address ?? "belum diinisialisasi"}</Text>
          <Text style={styles.label}>Saldo (lamports)</Text>
          <Text style={styles.mono}>{balance ?? 0}</Text>
        </View>
      )}
      <View style={styles.actions}>
        <Button title="Top Up" onPress={goTopup} disabled={busy} />
        <Button title="Tarik (Withdraw)" onPress={goWithdraw} disabled={busy} />
        <Button title="Kelola Passkey" onPress={goPasskey} />
      </View>
      <Button title="Keluar" onPress={onLogout} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 16 },
  title: { fontSize: 26, fontWeight: "700" },
  card: { backgroundColor: "#f2f2f5", borderRadius: 12, padding: 16, gap: 6 },
  label: { fontSize: 13, color: "#666" },
  mono: { fontFamily: "monospace", fontSize: 14 },
  actions: { gap: 10, marginTop: 8 },
  error: { color: "#c0392b" },
});