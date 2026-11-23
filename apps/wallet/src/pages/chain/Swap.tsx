import { useState } from "react";
import { TextField } from "../../shared/components/ui/TextField";
import { Pressable } from "../../shared/components/ui/Pressable";
import { ArrowDownUp } from "../../shared/components/icons";
import { usePeridot } from "../../shared/app/AppContext";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { UIButton } from "../../shared/components/ui/UIButton";
import { Label } from "../../shared/components/ui/Label";

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
    <div className="flex flex-1 flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <PushHeader onBack={onDone} title="Swap" />
          <p className="mt-2 text-sm text-muted-foreground">Swap between assets on the smart account.</p>
        </SectionHead>
      </Section>

      <Section>
        <SectionHead className="pb-8">
          <div className="flex flex-col gap-2">
            <Label>You pay</Label>
            <TextField className="[--placeholder:var(--color-muted-foreground)]" value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="0.0"  />
            <Label>From asset</Label>
            <TextField value={from} onChangeText={setFrom} autoCapitalize="none"  />

            <div className="my-2 flex flex-row items-center gap-3">
              <div className="h-px flex-1 bg-line"  />
              <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface">
                <ArrowDownUp size={16} className="text-foreground" />
              </div>
              <div className="h-px flex-1 bg-line"  />
            </div>

            <Label>You receive</Label>
            <span className="font-sans text-sm text-muted-foreground">
              No quote yet — swaps aren&apos;t available in this build, so no estimate is shown.
            </span>
            <Label>To asset</Label>
            <TextField value={to} onChangeText={setTo} autoCapitalize="none"  />
          </div>

          <div className="mt-4">
            <UIButton title="Swap coming soon" onPress={swap} disabled />
          </div>
        </SectionHead>
      </Section>
    </div>
  );
}
