import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";

// Shared button — web CutButton feel: sharp corners, 14px medium
// tracking-wide label, generous padding. Variants mirror the web
// solid/outline recipe (+ danger for destructive actions).
type Variant = "primary" | "outline" | "danger";

export function UIButton({
  title,
  note,
  icon,
  onPress,
  disabled,
  variant = "outline",
}: {
  title: string;
  note?: string;
  icon?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  variant?: Variant;
}) {
  const primary = variant === "primary";
  const danger = variant === "danger";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        primary && styles.primary,
        danger && styles.danger,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <View style={styles.content}>
        {icon}
        <Text
          style={[
            styles.label,
            primary && styles.labelPrimary,
            danger && styles.labelDanger,
            disabled && !primary && !danger && styles.labelDisabled,
          ]}
        >
          {title}
        </Text>
      </View>
      {note && <Text style={styles.note}>{note}</Text>}
    </Pressable>
  );
}

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  btn: {
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 0,
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  primary: {
    backgroundColor: c.foreground,
    borderColor: c.foreground,
  },
  danger: {
    borderColor: c.danger,
  },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.7 },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
    letterSpacing: 0.4,
    color: c.foreground,
    fontFamily: f.sansMedium,
  },
  labelPrimary: { color: c.background },
  labelDanger: { color: c.danger },
  labelDisabled: { color: c.mutedForeground },
  note: { fontSize: 11, color: c.mutedForeground, fontFamily: f.sans },
});
