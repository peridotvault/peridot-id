import { useCallback, useEffect, useState } from "react";
import { Image, ScrollView, Text, TouchableOpacity, View } from "../shared/primitives";
import { ChevronRight, RefreshCw, Settings } from "../shared/icons";
import type { AccountView, Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
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
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 12 }}>
      <Text style={s.title}>Profile</Text>

      <TouchableOpacity onPress={goEditProfile}>
        <View style={{ flexDirection: "row" }} className="w-full items-center gap-3 border border-border bg-surface p-3.5">
          {profile?.avatarUrl ? (
            <Image source={{ uri: profile.avatarUrl }} className="h-[34px] w-[34px] rounded-full border border-border" />
          ) : (
            <View className="h-[34px] w-[34px] items-center justify-center rounded-full bg-muted">
              <Text className="font-serif text-[15px] text-foreground">{(profile?.displayName ?? "?").slice(0, 1).toUpperCase()}</Text>
            </View>
          )}
          <Text className="flex-1 font-sans text-[15px] font-medium text-foreground">Edit Profile</Text>
          <ChevronRight size={16} className="text-muted-foreground" />
        </View>
      </TouchableOpacity>

      <TouchableOpacity onPress={openAccounts}>
        <View style={{ flexDirection: "row" }} className="w-full items-center gap-3 border border-border bg-surface p-3.5">
          <View className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-muted">
            <RefreshCw size={18} className="text-foreground" />
          </View>
          <Text className="flex-1 font-sans text-[15px] font-medium text-foreground">Switch Account</Text>
          <ChevronRight size={16} className="text-muted-foreground" />
        </View>
      </TouchableOpacity>

      <TouchableOpacity onPress={goSettings}>
        <View style={{ flexDirection: "row" }} className="w-full items-center gap-3 border border-border bg-surface p-3.5">
          <View className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-muted">
            <Settings size={18} className="text-foreground" />
          </View>
          <Text className="flex-1 font-sans text-[15px] font-medium text-foreground">Settings</Text>
          <ChevronRight size={16} className="text-muted-foreground" />
        </View>
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
