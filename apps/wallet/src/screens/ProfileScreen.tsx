import { useCallback, useEffect, useState } from "react";
import { ScrollArea } from "../shared/components/ScrollArea";
import { Pressable } from "../shared/components/Pressable";
import { ChevronRight, RefreshCw } from "../shared/icons";
import type { AccountView, Profile } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { AccountSwitcherModal } from "../shared/components/AccountSwitcherModal";
import { PushHeader } from "../shared/components/PushHeader";
import { progressWidth, xpProgressLabel } from "../feat/identity/utils/level";

export function ProfileScreen({
  onDone,
  onLogout,
  goEditProfile,
  onSwitched,
  onAddAccount,
}: {
  /** Push root: the header's back arrow pops the stack. */
  onDone: () => void;
  /** Kept for per-account sign-out inside the switcher modal. */
  onLogout: () => void;
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
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 12 }}>
      <PushHeader onBack={onDone} title="Profile" />

      <Pressable onPress={goEditProfile}>
        <div style={{ flexDirection: "row" }} className="flex flex-col w-full items-center gap-3 border border-border bg-surface p-3.5">
          {profile?.avatarUrl ? (
            <img src={profile.avatarUrl} alt="" className="h-[34px] w-[34px] rounded-full border border-border"  />
          ) : (
            <div className="flex flex-col h-[34px] w-[34px] items-center justify-center rounded-full bg-muted" aria-label="No profile photo">
              <span aria-hidden="true" className="font-serif text-base text-foreground">{(profile?.displayName ?? "?").slice(0, 1).toUpperCase()}</span>
            </div>
          )}
          <span className="flex-1 font-sans text-base font-medium text-foreground">Edit Profile</span>
          <ChevronRight size={16} className="text-muted-foreground" />
        </div>
      </Pressable>

      {profile?.level && (
        <div
          className="flex flex-col w-full gap-2 border border-border bg-surface p-3.5"
          aria-label={`Level ${profile.level.level}, ${xpProgressLabel(profile.level)}`}
        >
          <div style={{ flexDirection: "row" }} className="flex flex-col items-baseline justify-between">
            <span className="font-sans text-base font-medium text-foreground">Level {profile.level.level}</span>
            <span className="font-sans text-sm text-muted-foreground">{xpProgressLabel(profile.level)}</span>
          </div>
          <div className="flex flex-col h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="flex flex-col h-full rounded-full bg-foreground" style={{ width: `${progressWidth(profile.level)}%` }}  />
          </div>
        </div>
      )}

      <Pressable onPress={openAccounts}>
        <div style={{ flexDirection: "row" }} className="flex flex-col w-full items-center gap-3 border border-border bg-surface p-3.5">
          <div className="flex flex-col flex h-[34px] w-[34px] items-center justify-center rounded-full bg-muted">
            <RefreshCw size={18} className="text-foreground" />
          </div>
          <span className="flex-1 font-sans text-base font-medium text-foreground">Switch Account</span>
          <ChevronRight size={16} className="text-muted-foreground" />
        </div>
      </Pressable>

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
    </ScrollArea>
  );
}
