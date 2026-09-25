import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

type StepKey = "identity" | "wallet";
type StepStatus = "pending" | "running" | "done" | "failed";

const STEPS: { key: StepKey; label: string; hint: string }[] = [
  { key: "identity", label: "Identity", hint: "Your PID session" },
  { key: "wallet", label: "Wallet", hint: "Your on-chain account record" },
];

async function runOne(peridot: PeridotClient, key: StepKey): Promise<void> {
  if (key === "identity") {
    const me = await peridot.identity.me();
    if (typeof me === "object" && me !== null && "statusCode" in me) {
      throw new Error("Session expired — please sign in again.");
    }
    return;
  }
  let acc = await peridot.wallet.me();
  if (typeof acc === "object" && acc !== null && "statusCode" in acc) acc = await peridot.wallet.createAccount();
  if (typeof acc === "object" && acc !== null && "statusCode" in acc) {
    throw new Error("Could not set up the wallet — try again.");
  }
}

function glyph(status: StepStatus): string {
  switch (status) {
    case "done": return "✓";
    case "failed": return "✗";
    case "running": return "…";
    default: return "○";
  }
}

/**
 * Post-auth provisioning stepper (login + PID-claim funnel).
 * Runs identity → wallet with visible progress; every step is idempotent,
 * failures show an inline Retry, and "Continue to home" is always available
 * so a provider outage never traps the user.
 */
export function ProvisioningScreen({ onContinue }: { onContinue: () => void }) {
  const { peridot } = usePeridot();
  const [states, setStates] = useState<Record<StepKey, { status: StepStatus; error: string | null }>>({
    identity: { status: "pending", error: null },
    wallet: { status: "pending", error: null },
  });
  const started = useRef(false);

  const run = useCallback(
    async (key: StepKey) => {
      setStates((prev) => ({ ...prev, [key]: { status: "running", error: null } }));
      try {
        await runOne(peridot, key);
        setStates((prev) => ({ ...prev, [key]: { status: "done", error: null } }));
      } catch (e) {
        setStates((prev) => ({ ...prev, [key]: { status: "failed", error: e instanceof Error ? e.message : String(e) } }));
      }
    },
    [peridot],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      for (const step of STEPS) {
        // eslint-disable-next-line no-await-in-loop
        await run(step.key);
      }
    })();
  }, [run]);

  return (
    <View style={s.container}>
      <Text style={s.title}>Setting up your wallet</Text>
      <Text style={s.subtitle}>Creating your on-chain account — this usually takes a few seconds.</Text>

      {STEPS.map((step) => {
        const st = states[step.key];
        return (
          <View key={step.key} style={styles.card}>
            <View style={styles.row}>
              <Text style={[styles.glyph, st.status === "done" && styles.glyphDone, st.status === "failed" && styles.glyphFailed]}>
                {glyph(st.status)}
              </Text>
              <View style={styles.meta}>
                <Text style={styles.label}>{step.label}</Text>
                <Text style={styles.hint}>{step.hint}</Text>
              </View>
              {st.status === "failed" && (
                <TouchableOpacity style={styles.retry} onPress={() => run(step.key)} accessibilityLabel={`Retry ${step.label}`}>
                  <Text style={styles.retryLabel}>Retry</Text>
                </TouchableOpacity>
              )}
            </View>
            {st.error && <Text style={s.error}>{st.error}</Text>}
          </View>
        );
      })}

      <UIButton title="Continue to home" onPress={onContinue} variant="primary" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    gap: 8,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  glyph: { fontSize: 20, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sansSemiBold, width: 28, textAlign: "center" },
  glyphDone: { color: theme.colors.success ?? theme.colors.foreground },
  glyphFailed: { color: theme.colors.danger ?? theme.colors.foreground },
  meta: { flex: 1, gap: 2 },
  label: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  hint: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  retry: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  retryLabel: { fontSize: 13, color: theme.colors.foreground, fontFamily: theme.fonts.sansMedium },
});
