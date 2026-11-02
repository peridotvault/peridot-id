import { Pressable } from "./Pressable";

// Inline retry affordance for recoverable read errors (text + underline rule).
export function Retry({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <div className="mt-2 flex items-center self-start border-b border-foreground py-1">
        <span className="font-sans text-sm font-medium text-foreground">Retry</span>
      </div>
    </Pressable>
  );
}
