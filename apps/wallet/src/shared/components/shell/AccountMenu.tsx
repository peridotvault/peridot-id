import type { AccountView } from "@peridotvault/pid-types";
import { Pressable } from "../ui/Pressable";
import { Check, Plus, User } from "../icons";

/** What the profile popover needs; both the shell hook and the login consent
 *  flow satisfy it, so one presentational menu serves both. */
export interface AccountMenuModel {
  open: boolean;
  accounts: AccountView[];
  busy: boolean;
  error: string | null;
  openMenu: () => void;
  closeMenu: () => void;
  select: (pid: string) => void;
  /** Start a login for another identity. Omitted = no Add row. */
  add?: () => void;
}

// Rows of the profile popover (Internet Identity's account menu): every
// identity signed into this browser, the active one checked, plus quiet
// Profile / Add rows. The chrome (scrim, position, motion) is the shared
// `Popover` from @peridotvault/pid-ui.
export function AccountMenu({
  accounts,
  busy,
  error,
  onSelect,
  onAdd,
  onProfile,
}: {
  accounts: AccountView[];
  busy: boolean;
  error: string | null;
  onSelect: (pid: string) => void;
  onAdd?: () => void;
  onProfile?: () => void;
}) {
  return (
    <>
      {error && <p role="alert" className="px-3 py-2 font-sans text-xs text-danger">{error}</p>}
      {accounts.length === 0 && !error && (
        <p className="px-3 py-2 font-sans text-xs text-muted-foreground">No accounts signed in.</p>
      )}
      {accounts.map((a) => (
        <Pressable
          key={a.pid}
          onPress={() => onSelect(a.pid)}
          disabled={busy}
          accessibilityRole="menuitem"
          accessibilityLabel={`Switch to ${a.pid}`}
        >
          <div className="flex w-full items-center gap-3 rounded-md p-2 hover:bg-muted/40">
            {a.avatarUrl ? (
              <img src={a.avatarUrl} alt="" className="h-8 w-8 rounded-md border border-line" />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-md border border-line bg-muted" aria-hidden="true">
                <span className="font-sans text-sm text-foreground">{(a.displayName ?? a.pid).slice(0, 1).toUpperCase()}</span>
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-sans text-sm font-medium text-foreground">{a.displayName ?? a.pid}</span>
              <span className="truncate font-sans text-xs text-muted-foreground">{a.pid}</span>
            </div>
            {a.isActive && <Check size={16} className="shrink-0 text-foreground" aria-label="Current account" />}
          </div>
        </Pressable>
      ))}

      {onProfile && (
        <Pressable onPress={onProfile} accessibilityRole="menuitem" accessibilityLabel="Profile">
          <div className="flex w-full items-center gap-3 rounded-md p-2 hover:bg-muted/40">
            <User size={16} className="text-muted-foreground" aria-hidden="true" />
            <span className="font-sans text-sm text-foreground">Profile</span>
          </div>
        </Pressable>
      )}
      {onAdd && (
        <Pressable onPress={onAdd} disabled={busy} accessibilityRole="menuitem" accessibilityLabel="Add account">
          <div className="flex w-full items-center gap-3 rounded-md p-2 hover:bg-muted/40">
            <Plus size={16} className="text-muted-foreground" aria-hidden="true" />
            <span className="font-sans text-sm text-foreground">Add account</span>
          </div>
        </Pressable>
      )}
    </>
  );
}
