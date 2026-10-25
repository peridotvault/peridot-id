import { useState } from "react";
import { TextField } from "../../shared/components/ui/TextField";
import { Pressable } from "../../shared/components/ui/Pressable";
import { ArrowDownUp } from "../../shared/components/icons";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";

export function Swap({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [from, setFrom] = useState("SOL");
  const [to, setTo] = useState("USDC");
  const [amount, setAmount] = useState("");

  const swap = async () => {
    // ponytail: swap is a stub — no DEX/quote backend exists yet. The CTA
    // below stays disabled until a real quote path lands.
  };

  return (
    <div style={s.container} className="flex flex-col">
      <PushHeader onBack={onDone} title="Swap" />
      <p style={s.subtitle}>Swap between assets on the smart account.</p>

      <div className="flex flex-col gap-2">
        <span style={s.label}>You pay</span>
        <TextField style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="0.0"  />
        <span style={s.label}>From asset</span>
        <TextField style={s.input} value={from} onChangeText={setFrom} autoCapitalize="none"  />

        <div style={{ flexDirection: "row" }} className="flex flex-col my-2 items-center gap-3">
          <div className="flex flex-col h-px flex-1 bg-border"  />
          <div className="flex flex-col flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface">
            <ArrowDownUp size={16} className="text-foreground" />
          </div>
          <div className="flex flex-col h-px flex-1 bg-border"  />
        </div>

        <span style={s.label}>You receive</span>
        <span className="font-sans text-sm text-muted-foreground">
          No quote yet — swaps aren&apos;t available in this build, so no estimate is shown.
        </span>
        <span style={s.label}>To asset</span>
        <TextField style={s.input} value={to} onChangeText={setTo} autoCapitalize="none"  />
      </div>

      <Pressable
        onPress={swap}
        disabled
        accessibilityRole="button"
        accessibilityState={{ disabled: true }}
        accessibilityLabel="Swap (unavailable — coming soon)"
      >
        <div className="flex flex-col w-full items-center border border-border bg-surface p-3.5 opacity-60">
          <span className="font-sans text-sm font-medium text-muted-foreground">Swap coming soon</span>
        </div>
      </Pressable>
    </div>
  );
}
