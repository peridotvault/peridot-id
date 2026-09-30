import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { theme, styles as s } from "../../../shared/theme";
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
    <View style={styles.screen}>
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <View style={s.container}>
      <View style={styles.claimHeader}>
        <Pressable onPress={onSignOut} disabled={busy} accessibilityLabel="Sign out and cancel PID creation">
          <Text style={styles.signOut}>Sign Out</Text>
        </Pressable>
      </View>
      <View style={styles.middle}>
        <View style={styles.masthead}>
          <Text style={styles.title}>Create your PID</Text>
          {(email || displayName) && (
            <Text style={styles.subtitle}>Continuing as {displayName ?? email}</Text>
          )}
        </View>
        {error && <Text style={s.error}>{error}</Text>}
        <View style={styles.stack}>
          <View style={styles.handleWrap}>
            <TextInput
              style={[s.input, styles.handleInput]}
              value={handle}
              onChangeText={onHandle}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="username"
              placeholderTextColor={theme.colors.mutedForeground}
              editable={!busy}
            />
            <Text style={styles.suffixInside} pointerEvents="none">@pid</Text>
          </View>
          {handleStatus === "free" && <Text style={styles.free}>✓ {handle.trim().toLowerCase()}@pid is available</Text>}
          {handleStatus === "taken" && <Text style={s.error}>Taken — try another handle.</Text>}
          {handleStatus === "invalid" && handle.length > 0 && (
            <Text style={s.error}>3-20 chars: lowercase letters, numbers, underscore.</Text>
          )}
          <Pressable
            style={styles.ackRow}
            onPress={onAck}
            disabled={busy}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ackPermanent }}
          >
            <View style={[styles.ackBox, ackPermanent && styles.ackBoxChecked]}>
              {ackPermanent && <Text style={styles.ackTick}>✓</Text>}
            </View>
            <Text style={styles.warn}>
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

const styles = StyleSheet.create({
  screen: { flex: 1 },
  middle: { flex: 1, width: "100%", alignItems: "center", justifyContent: "center", gap: 20 },
  masthead: { alignItems: "center", gap: 8 },
  title: {
    fontSize: 40,
    fontWeight: "400",
    color: theme.colors.foreground,
    fontFamily: "SourceSerif4_400Regular",
    letterSpacing: -0.4,
  },
  subtitle: { fontSize: 14, color: theme.colors.mutedForeground, fontFamily: "Geist_400Regular" },
  stack: { width: "100%", maxWidth: 343, gap: 12 },
  claimHeader: { width: "100%", flexDirection: "row", justifyContent: "flex-end", alignItems: "center", paddingTop: 8 },
  signOut: { fontSize: 14, color: theme.colors.danger ?? theme.colors.mutedForeground, fontFamily: "Geist_400Regular" },
  handleWrap: { position: "relative", flex: 1, justifyContent: "center" },
  handleInput: { flex: 1, paddingRight: 64 },
  suffixInside: {
    position: "absolute",
    right: 12,
    fontSize: 15,
    color: theme.colors.mutedForeground,
    fontFamily: "Geist_400Regular",
  },
  free: { fontSize: 12, color: theme.colors.success ?? theme.colors.foreground, fontFamily: "Geist_400Regular" },
  warn: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: "Geist_400Regular", flex: 1 },
  ackRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  ackBox: {
    width: 22,
    height: 22,
    borderWidth: 1,
    borderColor: theme.colors.mutedForeground,
    alignItems: "center",
    justifyContent: "center",
  },
  ackBoxChecked: { borderColor: theme.colors.foreground },
  ackTick: { fontSize: 14, color: theme.colors.foreground, fontFamily: "Geist_400Regular" },
});
