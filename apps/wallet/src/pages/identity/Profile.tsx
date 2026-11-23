import { useCallback, useEffect, useState } from "react";
import { Pressable } from "../../shared/components/ui/Pressable";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { ChevronRight, RefreshCw } from "../../shared/components/icons";
import type { AccountView, Profile as ProfileData } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { AccountSwitcherModal } from "../../shared/components/shell/AccountSwitcherModal";
import { ListRow, RowTile } from "../../shared/components/ui/ListRow";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { progressWidth, xpProgressLabel } from "../../feat/identity/utils/level";

export function Profile({
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
  const [profile, setProfile] = useState<ProfileData | null>(null);

  const [accountsOpen, setAccountsOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await peridot.profile.me();
    if ("statusCode" in res) return;
    setProfile(res as ProfileData);
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
    <div className="flex flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <PushHeader onBack={onDone} title="Profile" />
        </SectionHead>
      </Section>

      <Section>
        <div className="flex flex-col divide-y divide-line">
          <ListRow onPress={goEditProfile} hairline={false}>
            {profile?.avatarUrl ? (
              <img src={profile.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-md border border-line" />
            ) : (
              <RowTile>
                <span aria-hidden="true" className="font-sans text-base text-foreground">{(profile?.displayName ?? "?").slice(0, 1).toUpperCase()}</span>
              </RowTile>
            )}
            <span className="flex-1 font-sans text-base font-medium text-foreground">Edit Profile</span>
            <ChevronRight size={16} className="text-muted-foreground" />
          </ListRow>

          <ListRow onPress={openAccounts} hairline={false}>
            <RowTile>
              <RefreshCw size={18} className="text-foreground" />
            </RowTile>
            <span className="flex-1 font-sans text-base font-medium text-foreground">Switch Account</span>
            <ChevronRight size={16} className="text-muted-foreground" />
          </ListRow>
        </div>
      </Section>

      {profile?.level && (
        <Section aria-label={`Level ${profile.level.level}, ${xpProgressLabel(profile.level)}`}>
          <SectionHead className="pb-0">
            <div className="flex w-full flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <span className="font-sans text-base font-medium text-foreground">Level <span className="font-sans text-lg font-semibold leading-none">{profile.level.level}</span></span>
                <span className="font-sans text-sm text-muted-foreground">{xpProgressLabel(profile.level)}</span>
              </div>
              <div className="flex h-1.5 w-full overflow-hidden bg-line">
                <div className="h-full bg-accent" style={{ width: `${progressWidth(profile.level)}%` }}  />
              </div>
            </div>
          </SectionHead>
        </Section>
      )}

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
    </div>
  );
}
