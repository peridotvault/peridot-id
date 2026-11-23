import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable } from "../../shared/components/ui/Pressable";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../../shared/app/AppContext";
import { UIButton } from "../../shared/components/ui/UIButton";
import { ensureChainRows } from "../../feat/chain/utils/chainRows";

type StepKey = "identity" | "passkey" | "wallet";
type StepStatus = "pending" | "running" | "done" | "failed";

const STEPS: { key: StepKey; label: string; hint: string }[] = [
  { key: "identity", label: "Identity", hint: "Your PID session" },
  { key: "passkey", label: "Passkey", hint: "Signs for your wallet — replaces a seed phrase" },
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
  if (key === "passkey") {
    // A wallet-only identity (MetaMask / Phantom login) starts with no passkey,
    // and the smart account's only authority IS a passkey — without one
    // POST /v1/account defers every row by design (ANT-866 B1) and the wallet
    // step could never succeed.
    const keys = await peridot.passkey.list();
    if (Array.isArray(keys) && keys.length > 0) return;
    // shortcut: relies on the browser allowing credentials.create() without a
    // fresh tap; the Retry button supplies the gesture where it does not.
    await peridot.passkey.register();
    return;
  }
  const acc = await ensureChainRows(peridot);
  if (typeof acc === "object" && acc !== null && "statusCode" in acc) {
    const message = (acc as { message?: string | string[] }).message;
    throw new Error((Array.isArray(message) ? message.join(" ") : message) || "Could not set up the wallet — try again.");
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
export function Provisioning({ onContinue }: { onContinue: () => void }) {
  const { peridot } = usePeridot();
  const [states, setStates] = useState<Record<StepKey, { status: StepStatus; error: string | null }>>({
    identity: { status: "pending", error: null },
    passkey: { status: "pending", error: null },
    wallet: { status: "pending", error: null },
  });
  const started = useRef(false);

  const run = useCallback(
    async (key: StepKey): Promise<boolean> => {
      setStates((prev) => ({ ...prev, [key]: { status: "running", error: null } }));
      try {
        await runOne(peridot, key);
        setStates((prev) => ({ ...prev, [key]: { status: "done", error: null } }));
        return true;
      } catch (e) {
        setStates((prev) => ({ ...prev, [key]: { status: "failed", error: e instanceof Error ? e.message : String(e) } }));
        return false;
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
        if (!(await run(step.key))) break;
      }
    })();
  }, [run]);

  return (
    <div className="flex flex-1 flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <h1 className="text-xl font-semibold text-foreground">Setting up your wallet</h1>
          <p className="mt-2 text-sm text-muted-foreground">Creating your on-chain account — this usually takes a few seconds.</p>
        </SectionHead>
      </Section>

      <Section>
        <div className="flex flex-col divide-y divide-line">
            {STEPS.map((step) => {
              const st = states[step.key];
              return (
                <div key={step.key} className="flex flex-col px-6 py-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-7 text-center font-sans text-xl font-semibold ${st.status === "done" ? "text-success" : st.status === "failed" ? "text-danger" : "text-muted-foreground"}`}
                      aria-label={`${step.label}: ${stepStatusLabel(st.status)}`}
                    >
                      {glyph(st.status)}
                    </span>
                    <div className="flex flex-1 flex-col gap-0.5">
                      <span className="font-sans text-base font-semibold text-foreground">{step.label}</span>
                      <span className="font-sans text-xs text-muted-foreground">{step.hint}</span>
                    </div>
                    {st.status === "failed" && (
                      <Pressable onPress={() => run(step.key)} accessibilityLabel={`Retry ${step.label}`}>
                        <div className="rounded-md border border-border px-3 py-1.5">
                          <span className="font-sans text-sm font-medium text-foreground">Retry</span>
                        </div>
                      </Pressable>
                    )}
                  </div>
                  {st.error && <p role="alert" className="mt-2 font-sans text-sm text-foreground">{st.error}</p>}
                </div>
              );
            })}
          </div>

        <div className="px-6 py-4">
          <UIButton title="Continue to home" onPress={onContinue} variant="primary" />
        </div>
      </Section>
    </div>
  );
}
