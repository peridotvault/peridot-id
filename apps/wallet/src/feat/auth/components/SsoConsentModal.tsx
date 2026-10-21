import { Pressable, Text, View } from "../../../shared/primitives";
import { X } from "../../../shared/icons";
import { styles as s } from "../../../shared/theme";
import { UIButton } from "../../../shared/components/UIButton";

// One-tap SSO consent as an overlay modal: dimmed scrim + centered card.
// Rendered over the live app screen (and the login backdrop) — the login
// form itself stays a full screen in LoginScreen.
export function SsoConsentModal({
  origin,
  sessionLabel,
  busy,
  error,
  onAllow,
  onDifferent,
  onDeny,
  verified,
}: {
  origin: string;
  sessionLabel: string;
  busy: boolean;
  error: string | null;
  onAllow: () => void;
  onDifferent: () => void;
  onDeny: () => void;
  /** Verified partner: PeridotID fee waived for this app (trust signal). */
  verified?: boolean;
}) {
  return (
    <View className="absolute inset-0 z-10 items-center justify-center p-6">
      <View className="absolute inset-0 bg-black/60" />
      {/* relative + z lifts the card above the absolute scrim. */}
      <View className="relative z-10 w-full max-w-[380px] gap-3 border border-border bg-surface p-5">
        <Pressable onPress={onDeny} disabled={busy} accessibilityLabel="Deny and close" className="absolute right-2 top-2 z-[1]">
          <View className="p-2">
            <X size={18} className="text-muted-foreground" />
          </View>
        </Pressable>
        <Text className="text-center font-serif text-[28px] tracking-[-0.3px] text-foreground">PeridotID</Text>
        <Text className="text-center font-sans text-sm font-medium text-foreground">Allow {origin} to sign in with your PeridotID?</Text>
        {verified ? <Text className="text-center font-sans text-xs text-success"><Text aria-hidden="true">✓ </Text>Verified partner — 0% PeridotID fee</Text> : null}
        <Text className="text-center font-sans text-xs text-muted-foreground">
          Signed in as {sessionLabel}. The app receives your ID, display name and email — never your passkeys.
        </Text>
        {error && <Text style={s.error}>{error}</Text>}
        <View className="mt-1 gap-3">
          <UIButton title={busy ? "Authorizing…" : "Allow"} onPress={onAllow} disabled={busy} variant="primary" />
          <UIButton title="Use a different account" onPress={onDifferent} disabled={busy} />
          <UIButton title="Deny" onPress={onDeny} disabled={busy} variant="danger" />
        </View>
      </View>
    </View>
  );
}
