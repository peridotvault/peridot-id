import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable } from "../shared/components/Pressable";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { UIButton } from "../shared/components/UIButton";

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

function stepStatusLabel(status: StepStatus): string {
  switch (status) {
    case "done": return "done";
    case "failed": return "failed";
    case "running": return "in progress";
    default: return "pending";
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
    <div style={s.container} className="flex flex-col">
      <h1 style={s.title}>Setting up your wallet</h1>
      <p style={s.subtitle}>Creating your on-chain account — this usually takes a few seconds.</p>

      {STEPS.map((step) => {
        const st = states[step.key];
        return (
          <div key={step.key} className="flex flex-col mt-3 gap-2 border border-border bg-surface p-3">
            <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-3">
              <span
                className={`w-7 text-center font-sans text-xl font-semibold ${st.status === "done" ? "text-success" : st.status === "failed" ? "text-danger" : "text-muted-foreground"}`}
                aria-label={`${step.label}: ${stepStatusLabel(st.status)}`}
              >
                {glyph(st.status)}
              </span>
              <div className="flex flex-col flex-1 gap-0.5">
                <span className="font-sans text-base font-semibold text-foreground">{step.label}</span>
                <span className="font-sans text-xs text-muted-foreground">{step.hint}</span>
              </div>
              {st.status === "failed" && (
                <Pressable onPress={() => run(step.key)} accessibilityLabel={`Retry ${step.label}`}>
                  <div className="flex flex-col border border-border bg-background px-3 py-1.5">
                    <span className="font-sans text-sm font-medium text-foreground">Retry</span>
                  </div>
                </Pressable>
              )}
            </div>
            {st.error && <p role="alert" style={s.error}>{st.error}</p>}
          </div>
        );
      })}

      <UIButton title="Continue to home" onPress={onContinue} variant="primary" />
    </div>
  );
}
