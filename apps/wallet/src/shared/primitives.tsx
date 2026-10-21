import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { assertSafeExternalUrl } from "./safeUrl";

// DOM shims with the react-native call-shape, so screens keep their JSX and
// StyleSheet objects verbatim. Web-only wallet: no native runtime, so these
// render plain DOM with RN layout semantics (column flex, shorthands).

// Loose member: RN style objects use plain strings ("row", "center") and
// RN-only keys (marginHorizontal, …) that CSSProperties rejects. Visual
// props, not correctness — exactness here isn't worth call-site churn.
type LooseStyle = { [key: string]: string | number | boolean | undefined };

export type StyleProp = CSSProperties | LooseStyle | false | null | undefined | StyleProp[];

// RN-only keys that appear in wallet styles — expanded to real CSS.
type Expanded = {
  marginHorizontal?: CSSProperties["marginLeft"];
  marginVertical?: CSSProperties["marginTop"];
  paddingHorizontal?: CSSProperties["paddingLeft"];
  paddingVertical?: CSSProperties["paddingTop"];
  elevation?: number;
};

export function flatten(style: StyleProp): CSSProperties {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  const { marginHorizontal, marginVertical, paddingHorizontal, paddingVertical, elevation, ...rest } =
    style as CSSProperties & Expanded;
  void elevation;
  const out: CSSProperties = { ...rest };
  if (marginHorizontal !== undefined) {
    out.marginLeft ??= marginHorizontal;
    out.marginRight ??= marginHorizontal;
  }
  if (marginVertical !== undefined) {
    out.marginTop ??= marginVertical;
    out.marginBottom ??= marginVertical;
  }
  if (paddingHorizontal !== undefined) {
    out.paddingLeft ??= paddingHorizontal;
    out.paddingRight ??= paddingHorizontal;
  }
  if (paddingVertical !== undefined) {
    out.paddingTop ??= paddingVertical;
    out.paddingBottom ??= paddingVertical;
  }
  return out;
}

type DivProps = Omit<HTMLAttributes<HTMLDivElement>, "style"> & { style?: StyleProp; pointerEvents?: CSSProperties["pointerEvents"] };

// RN View is a column flex box — every wallet style relies on it (gap, align).
export function View({ style, pointerEvents, ...rest }: DivProps) {
  return <div {...rest} style={{ display: "flex", flexDirection: "column", pointerEvents, ...flatten(style) }} />;
}

export const SafeAreaView = View;

type TextProps = Omit<HTMLAttributes<HTMLSpanElement>, "style"> & {
  style?: StyleProp;
  numberOfLines?: number;
  selectable?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  pointerEvents?: CSSProperties["pointerEvents"];
};

export function Text({ style, numberOfLines, selectable, onPress, accessibilityLabel, pointerEvents, ...rest }: TextProps) {
  const flat = flatten(style);
  if (numberOfLines === 1) {
    flat.overflow = "hidden";
    flat.textOverflow = "ellipsis";
    flat.whiteSpace = "nowrap";
  }
  return (
    <span
      {...rest}
      aria-label={accessibilityLabel}
      onClick={onPress}
      style={{ ...(onPress ? { cursor: "pointer" } : null), userSelect: selectable ? "text" : undefined, pointerEvents, ...flat }}
    />
  );
}

type PressableProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> & {
  style?: StyleProp | ((state: { pressed: boolean }) => StyleProp);
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { selected?: boolean; checked?: boolean; disabled?: boolean; busy?: boolean; expanded?: boolean };
};

function PressableBase({ style, onPress, disabled, accessibilityLabel, accessibilityRole, accessibilityState, children, ...rest }: PressableProps) {
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

export const Pressable = PressableBase;
export const TouchableOpacity = PressableBase;

const KEYBOARD_TYPE: Record<string, { type?: string; inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"] }> = {
  "email-address": { type: "email" },
  "numeric": { inputMode: "numeric" },
  "number-pad": { inputMode: "numeric" },
  "decimal-pad": { inputMode: "decimal" },
  "phone-pad": { type: "tel" },
};

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "style" | "onChange" | "type" | "autoCorrect"> & {
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

export function TextInput({
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
}: TextInputProps) {
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

type ScrollViewProps = DivProps & {
  contentContainerStyle?: StyleProp;
  horizontal?: boolean;
};

export function ScrollView({ style, contentContainerStyle, horizontal, children, ...rest }: ScrollViewProps) {
  return (
    <div
      {...rest}
      style={{
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        overflowX: horizontal ? "auto" : "hidden",
        overflowY: horizontal ? "hidden" : "auto",
        ...flatten(style),
      }}
    >
      <div style={{ display: "flex", flexDirection: horizontal ? "row" : "column", flex: 1, ...flatten(contentContainerStyle) }}>
        {children}
      </div>
    </div>
  );
}

export function Modal({
  visible,
  onRequestClose,
  children,
  label,
}: {
  visible?: boolean;
  transparent?: boolean;
  animationType?: string;
  onRequestClose?: () => void;
  children?: ReactNode;
  label?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!visible) return;
    // Return-focus: remember the trigger so close restores it (ANT-341 FR3).
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const focusables = () =>
      Array.from(
        container?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    // Initial focus: first focusable, else the dialog itself.
    const first = focusables()[0];
    (first ?? container)?.focus?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onRequestClose?.();
        return;
      }
      // Focus trap: keep Tab inside the dialog (ANT-341 FR3).
      if (e.key === "Tab") {
        const items = focusables();
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const firstItem = items[0]!;
        const lastItem = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstItem) {
          e.preventDefault();
          lastItem.focus();
        } else if (!e.shiftKey && document.activeElement === lastItem) {
          e.preventDefault();
          firstItem.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [visible, onRequestClose]);
  if (!visible) return null;
  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      style={{ position: "fixed", inset: 0, zIndex: 50, outline: "none" }}
    >
      {children}
    </div>
  );
}

export function Image({ source, style, ...rest }: Omit<ImgHTMLAttributes<HTMLImageElement>, "style" | "src"> & {
  source?: { uri?: string };
  style?: StyleProp;
}) {
  return <img {...rest} src={source?.uri} alt="" style={flatten(style)} />;
}

// Cached snapshot — a fresh object every call would loop useSyncExternalStore
// (it compares with Object.is). Only replace on an actual size change.
let viewport = { width: 0, height: 0 };
const serverViewport = { width: 0, height: 0 };
function readViewport() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (viewport.width !== w || viewport.height !== h) viewport = { width: w, height: h };
  return viewport;
}
function subscribeViewport(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

export function useWindowDimensions() {
  return useSyncExternalStore(subscribeViewport, readViewport, () => serverViewport);
}

export const StyleSheet = {
  // Unconstrained generic: preserves string-literal types ("row", "center")
  // so style objects stay assignable to CSSProperties.
  create<T>(styles: T): T {
    return styles;
  },
  flatten,
  absoluteFillObject: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as CSSProperties,
  hairlineWidth: 1,
};

export const Platform = {
  OS: "web" as const,
  select<T>(spec: { web?: T; native?: T; default?: T }): T | undefined {
    return spec.web ?? spec.default;
  },
};

type AlertButton = { text?: string; style?: "cancel" | "destructive" | "default"; onPress?: () => void };

export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[]) {
    const body = message ? `${title}\n\n${message}` : title;
    if (!buttons || buttons.length === 0) {
      window.alert(body);
      return;
    }
    const cancel = buttons.find((b) => b.style === "cancel");
    const confirm = buttons.find((b) => b !== cancel);
    if (window.confirm(body)) confirm?.onPress?.();
    else cancel?.onPress?.();
  },
};

export const Linking = {
  // Anchor click, not a popup call (CI forbids those outside feat/embed).
  // ANT-346 M10: https-only — a non-https target rejects instead of opening,
  // so a poisoned paymentUrl / explorer link can't downgrade navigation.
  openURL(url: string): Promise<void> {
    assertSafeExternalUrl(url);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return Promise.resolve();
  },
};
