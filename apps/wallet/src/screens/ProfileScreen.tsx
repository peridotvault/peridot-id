import { useCallback, useEffect, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ChevronRight, RefreshCw, Settings } from "../shared/icons";
import type { AccountView, Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { theme, styles as s } from "../shared/theme";
import { UIButton } from "../shared/components/UIButton";
import { AccountSwitcherModal } from "../shared/components/AccountSwitcherModal";

export function ProfileScreen({
  onLogout,
  goSettings,
  goEditProfile,
  onSwitched,
  onAddAccount,
}: {
  onLogout: () => void;
  goSettings: () => void;
  goEditProfile: () => void;
  /** Account switch completed — the app re-bootstraps onto the new identity. */
  onSwitched: () => void;
  /** Start signing in another identity without leaving the current one. */
  onAddAccount: () => void;
}) {
  const { peridot } = usePeridot();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await peridot.profile.me();
    if ("statusCode" in res) return;
    setProfile(res as Profile);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const loadAccounts = useCallback(async () => {
    const res = await peridot.auth.accounts();
    setAccounts(Array.isArray(res) ? (res as AccountView[]) : []);
  }, [peridot]);

  const openAccounts = () => {
    setError(null);
    setAccountsOpen(true);
    void loadAccounts();
  };

  const selectAccount = async (pid: string) => {
    if (pid === profile?.pid) return setAccountsOpen(false);
    setBusy(true);
    setError(null);
    try {
      if (!(await peridot.auth.switchAccount(pid))) throw new Error("Couldn't switch account.");
      setAccountsOpen(false);
      onSwitched();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const signOutAccount = async (pid: string) => {
    setBusy(true);
    setError(null);
    try {
      const wasActive = pid === profile?.pid;
      await peridot.auth.signOutAccount(pid);
      if (wasActive) {
        setAccountsOpen(false);
        onLogout();
        return;
      }
      await loadAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text style={s.title}>Profile</Text>

      <TouchableOpacity style={styles.row} onPress={goEditProfile}>
        {profile?.avatarUrl ? (
          <Image source={{ uri: profile.avatarUrl }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]}>
            <Text style={styles.thumbText}>{(profile?.displayName ?? "?").slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.rowLabel}>Edit Profile</Text>
        <ChevronRight size={16} color={theme.colors.mutedForeground} />
      </TouchableOpacity>

      <TouchableOpacity style={styles.row} onPress={openAccounts}>
        <View style={styles.rowIcon}>
          <RefreshCw size={18} color={theme.colors.foreground} />
        </View>
        <Text style={styles.rowLabel}>Switch Account</Text>
        <ChevronRight size={16} color={theme.colors.mutedForeground} />
      </TouchableOpacity>

      <TouchableOpacity style={styles.row} onPress={goSettings}>
        <View style={styles.rowIcon}>
          <Settings size={18} color={theme.colors.foreground} />
        </View>
        <Text style={styles.rowLabel}>Settings</Text>
        <ChevronRight size={16} color={theme.colors.mutedForeground} />
      </TouchableOpacity>

      <UIButton title="Sign Out" onPress={onLogout} variant="danger" />

      <AccountSwitcherModal
        visible={accountsOpen}
        accounts={accounts}
        busy={busy}
        error={error}
        onClose={() => setAccountsOpen(false)}
        onSelect={selectAccount}
        onAdd={() => {
          setAccountsOpen(false);
          onAddAccount();
        }}
        onSignOut={signOutAccount}
      />
    </ScrollView>
  );
}

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  container: { padding: 24, gap: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  thumb: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: c.border,
  },
  thumbFallback: {
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0,
  },
  thumbText: { fontSize: 15, fontWeight: "400", color: c.foreground, fontFamily: f.serif },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: { flex: 1, fontSize: 15, fontWeight: "500", color: c.foreground, fontFamily: f.sansMedium },
});
