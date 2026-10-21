import { Image, Pressable, ScrollView, Text, View } from "../primitives";
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
      {error && <Text role="alert" style={s.error}>{error}</Text>}

      <ScrollView className="grow-0">
        <View className="gap-2 py-1">
          {accounts.map((a) => (
            <Pressable
              key={a.pid}
              onPress={() => onSelect(a.pid)}
              disabled={busy || a.isActive}
              accessibilityLabel={`Switch to ${a.pid}`}
            >
              <View style={{ flexDirection: "row" }} className="w-full items-center gap-3 border border-border p-3">
                {a.avatarUrl ? (
                  <Image source={{ uri: a.avatarUrl }} className="h-9 w-9 rounded-full border border-border" />
                ) : (
                  <View className="h-9 w-9 items-center justify-center rounded-full bg-muted" aria-label="No profile photo">
                    <Text aria-hidden="true" className="font-serif text-[15px] text-foreground">{(a.displayName ?? a.pid).slice(0, 1).toUpperCase()}</Text>
                  </View>
                )}
                <View className="flex-1 gap-0.5">
                  <Text className="font-sans text-[15px] font-medium text-foreground" numberOfLines={1} title={a.displayName ?? a.pid}>
                    {a.displayName ?? a.pid}
                  </Text>
                  <Text className="font-sans text-xs text-muted-foreground" numberOfLines={1} title={a.pid}>
                    {a.pid}
                  </Text>
                </View>
                {a.isActive ? (
                  <Check size={18} className="text-foreground" />
                ) : onSignOut ? (
                  <Pressable
                    onPress={() => onSignOut(a.pid)}
                    disabled={busy}
                    accessibilityLabel={`Sign out ${a.pid}`}
                  >
                    <View className="p-2">
                      <LogOut size={16} className="text-muted-foreground" />
                    </View>
                  </Pressable>
                ) : null}
              </View>
            </Pressable>
          ))}
          {accounts.length === 0 && <Text style={s.hint}>No accounts signed in.</Text>}
        </View>
      </ScrollView>

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
