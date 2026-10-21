import { Pressable, Text, TextInput, View } from "../../../shared/primitives";
import { styles as s } from "../../../shared/theme";
import { AsciiRidges } from "../../../shared/components/AsciiRidges";
import { UIButton } from "../../../shared/components/UIButton";
import type { HandleStatus } from "../hooks/usePidClaim";

// Claim branch: verified credential, no identity yet — the only way forward
// is creating the permanent <handle>@pid.
export function PidClaimForm({
  email,
  displayName,
  handle,
  handleStatus,
  ackPermanent,
  busy,
  error,
  onHandle,
  onAck,
  onSubmit,
  onSignOut,
}: {
  email: string | null;
  displayName: string | null;
  handle: string;
  handleStatus: HandleStatus;
  ackPermanent: boolean;
  busy: boolean;
  error: string | null;
  onHandle: (t: string) => void;
  onAck: () => void;
  onSubmit: () => void;
  onSignOut: () => void;
}) {
  return (
    <View className="flex-1">
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <View style={s.container}>
      <View style={{ flexDirection: "row" }} className="w-full items-center justify-end pt-2">
        <Pressable onPress={onSignOut} disabled={busy} accessibilityLabel="Sign out and cancel PID creation">
          <Text className="font-sans text-sm text-danger">Sign Out</Text>
        </Pressable>
      </View>
      <View className="flex-1 w-full items-center justify-center gap-5">
        <View className="items-center gap-2">
          <Text className="font-serif text-[40px] tracking-[-0.4px] text-foreground">Create your PID</Text>
          {(email || displayName) && (
            <Text className="font-sans text-sm text-muted-foreground">Continuing as {displayName ?? email}</Text>
          )}
        </View>
        {error && <Text role="alert" style={s.error}>{error}</Text>}
        <View className="w-full max-w-[343px] gap-3">
          <View className="relative flex-1 justify-center">
            <TextInput
                id="pid-claim-handle"
                aria-label="Choose your handle"
              style={[s.input, { paddingRight: 64 }]}
              className="[--placeholder:var(--color-muted-foreground)] outline-none"
              value={handle}
              onChangeText={onHandle}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="username"
              editable={!busy}
            />
            <Text pointerEvents="none" className="absolute right-3 font-sans text-[15px] text-muted-foreground">@pid</Text>
          </View>
          {handleStatus === "free" && <Text className="font-sans text-xs text-success"><Text aria-hidden="true">✓ </Text>{handle.trim().toLowerCase()}@pid is available</Text>}
          {handleStatus === "taken" && <Text role="alert" style={s.error}>Taken — try another handle.</Text>}
          {handleStatus === "invalid" && handle.length > 0 && (
            <Text role="alert" style={s.error}>3-20 chars: lowercase letters, numbers, underscore.</Text>
          )}
          <Pressable
            style={{ flexDirection: "row" }}
            className="items-center gap-2.5"
            onPress={onAck}
            disabled={busy}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ackPermanent }}
          >
            <View className={`h-[22px] w-[22px] items-center justify-center border ${ackPermanent ? "border-foreground" : "border-muted-foreground"}`}>
              {ackPermanent && <Text aria-hidden="true" className="font-sans text-sm text-foreground">✓</Text>}
            </View>
            <Text className="flex-1 font-sans text-xs text-muted-foreground">
              Your PID is permanent — it can never be changed, reused, or reassigned. Choose carefully.
            </Text>
          </Pressable>
          <UIButton
            title={busy ? "Creating…" : "Create & Continue"}
            onPress={onSubmit}
            disabled={busy || handleStatus !== "free" || !ackPermanent}
            variant="primary"
          />
        </View>
      </View>
      </View>
    </View>
  );
}
