import { Pressable } from "./Pressable";
import { ScrollArea } from "./ScrollArea";
import type { AccountView } from "@peridotvault/pid-types";
import { Check, LogOut, Plus } from "../icons";
import { styles as s } from "../theme";
import { BottomSheet } from "./BottomSheet";
import { UIButton } from "./UIButton";

// Bottom-sheet account switcher: every identity signed into this browser, the
// active one checked, "Add Account" at the bottom. Selecting switches the active
// session; the app re-bootstraps onto the chosen identity.
export function AccountSwitcherModal({
  visible,
  accounts,
  busy,
  error,
  onClose,
  onSelect,
  onAdd,
  onSignOut,
}: {
  visible: boolean;
  accounts: AccountView[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (pid: string) => void;
  onAdd: () => void;
  /** Omit to hide the per-account sign-out affordance (e.g. login picker). */
  onSignOut?: (pid: string) => void;
}) {
  return (
    <BottomSheet
      visible={visible}
      title="Switch Account"
      onClose={onClose}
      closeDisabled={busy}
      scrimLabel="Close account switcher"
    >
      {error && <p role="alert" style={s.error}>{error}</p>}

      <ScrollArea className="grow-0">
        <div className="flex flex-col gap-2 py-1">
          {accounts.map((a) => (
            <Pressable
              key={a.pid}
              onPress={() => onSelect(a.pid)}
              disabled={busy || a.isActive}
              accessibilityLabel={`Switch to ${a.pid}`}
            >
              <div style={{ flexDirection: "row" }} className="flex flex-col w-full items-center gap-3 border border-border p-3">
                {a.avatarUrl ? (
                  <img src={a.avatarUrl} alt="" className="h-9 w-9 rounded-full border border-border"  />
                ) : (
                  <div className="flex flex-col h-9 w-9 items-center justify-center rounded-full bg-muted" aria-label="No profile photo">
                    <span aria-hidden="true" className="font-serif text-base text-foreground">{(a.displayName ?? a.pid).slice(0, 1).toUpperCase()}</span>
                  </div>
                )}
                <div className="flex flex-col flex-1 gap-0.5">
                  <span className="whitespace-nowrap overflow-hidden text-ellipsis font-sans text-base font-medium text-foreground" title={a.displayName ?? a.pid}>
                    {a.displayName ?? a.pid}
                  </span>
                  <span className="whitespace-nowrap overflow-hidden text-ellipsis font-sans text-xs text-muted-foreground" title={a.pid}>
                    {a.pid}
                  </span>
                </div>
                {a.isActive ? (
                  <Check size={18} className="text-foreground" />
                ) : onSignOut ? (
                  <Pressable
                    onPress={() => onSignOut(a.pid)}
                    disabled={busy}
                    accessibilityLabel={`Sign out ${a.pid}`}
                  >
                    <div className="flex flex-col p-2">
                      <LogOut size={16} className="text-muted-foreground" />
                    </div>
                  </Pressable>
                ) : null}
              </div>
            </Pressable>
          ))}
          {accounts.length === 0 && <p style={s.hint}>No accounts signed in.</p>}
        </div>
      </ScrollArea>

      <UIButton
        title="Add Account"
        onPress={onAdd}
        disabled={busy}
        variant="primary"
        icon={<Plus size={16} className="text-foreground" />}
      />
    </BottomSheet>
  );
}
