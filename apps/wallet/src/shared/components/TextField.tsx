import type { CSSProperties, InputHTMLAttributes } from "react";
import { flatten, type StyleProp } from "../styles";

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
