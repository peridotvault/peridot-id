import type { CSSProperties, InputHTMLAttributes } from "react";
import { cn } from "../../styles/cn";
import { flatten, type StyleProp } from "../../styles/stylesheet";

// Design-system skin: every field looks the same unless the caller overrides it
// (the login email row opts out with `border-0 bg-transparent p-0`). 16px text
// is the iOS no-auto-zoom floor.
const FIELD_CLASS =
  "rounded-md border border-border bg-surface px-3 py-3 font-sans text-base text-foreground [--placeholder:var(--color-muted-foreground)]";

const KEYBOARD_TYPE: Record<string, { type?: string; inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"] }> = {
  "email-address": { type: "email" },
  "numeric": { inputMode: "numeric" },
  "number-pad": { inputMode: "numeric" },
  "decimal-pad": { inputMode: "decimal" },
  "phone-pad": { type: "tel" },
};

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "style" | "onChange" | "type" | "autoCorrect"> & {
  style?: StyleProp;
  onChangeText?: (text: string) => void;
  placeholderTextColor?: string;
  keyboardType?: keyof typeof KEYBOARD_TYPE & string;
  secureTextEntry?: boolean;
  editable?: boolean;
  autoCorrect?: boolean;
  returnKeyType?: InputHTMLAttributes<HTMLInputElement>["enterKeyHint"];
  onSubmitEditing?: () => void;
};

// DOM-first text field: a plain <input> with the wallet's RN-shaped call
// props (keyboardType, secureTextEntry, onChangeText, …) mapped to DOM.
export function TextField({
  style,
  className,
  value,
  onChangeText,
  placeholder,
  placeholderTextColor,
  keyboardType,
  secureTextEntry,
  editable = true,
  autoCorrect,
  returnKeyType,
  onSubmitEditing,
  ...rest
}: TextFieldProps) {
  const mapped = (keyboardType && KEYBOARD_TYPE[keyboardType]) || {};
  return (
    <input
      {...rest}
      data-slot="input"
      className={cn(FIELD_CLASS, className)}
      value={value}
      placeholder={placeholder}
      spellCheck={autoCorrect === false ? false : undefined}
      disabled={editable === false}
      type={secureTextEntry ? "password" : mapped.type || "text"}
      inputMode={mapped.inputMode}
      enterKeyHint={returnKeyType}
      onChange={(e) => onChangeText?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmitEditing?.();
      }}
      style={{ minWidth: 0, ...flatten(style), ...(placeholderTextColor ? { "--placeholder": placeholderTextColor } : null) } as CSSProperties}
    />
  );
}
