import { Pressable } from "../ui/Pressable";
import { ArrowLeft } from "../icons";

// Shared back affordance for detail screens: arrow + label, one line.
export function BackButton({ onPress, label = "Back" }: { onPress: () => void; label?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      style={{ flexDirection: "row" }}
      className="items-center gap-1.5"
    >
      <ArrowLeft size={18} className="text-foreground" />
      <span className="font-sans text-sm text-foreground">{label}</span>
    </Pressable>
  );
}
