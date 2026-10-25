import { useState, type ButtonHTMLAttributes } from "react";
import { flatten, type StyleProp } from "../../styles/stylesheet";

type PressableProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> & {
  style?: StyleProp | ((state: { pressed: boolean }) => StyleProp);
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { selected?: boolean; checked?: boolean; disabled?: boolean; busy?: boolean; expanded?: boolean };
};

// DOM-first pressable: a plain <button> with the wallet's reset look and
// pressed/disabled treatment. Same call-shape as the old RN shim so call
// sites only change the import.
export function Pressable({
  style,
  onPress,
  disabled,
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  children,
  ...rest
}: PressableProps) {
  const [pressed, setPressed] = useState(false);
  const flat = flatten(typeof style === "function" ? style({ pressed }) : style);
  return (
    <button
      type="button"
      {...rest}
      aria-label={accessibilityLabel}
      role={accessibilityRole}
      aria-selected={accessibilityState?.selected}
      aria-checked={accessibilityState?.checked}
      aria-disabled={accessibilityState?.disabled}
      aria-busy={accessibilityState?.busy}
      aria-expanded={accessibilityState?.expanded}
      disabled={disabled}
      onClick={disabled ? undefined : onPress}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "none",
        border: "none",
        padding: 0,
        margin: 0,
        font: "inherit",
        color: "inherit",
        textAlign: "inherit",
        cursor: disabled ? "default" : "pointer",
        ...flat,
      }}
    >
      {children}
    </button>
  );
}

export const TouchableOpacity = Pressable;
