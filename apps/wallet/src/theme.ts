import { StyleSheet } from "react-native";

// PeridotID brand theme — mirrors the marketing site (apps/docs): monochrome
// premium dark, serif display numerals, cut-corner aesthetic.

export const theme = {
  colors: {
    background: "#0a0a0a",
    surface: "#141414",
    muted: "#171717",
    border: "#262626",
    foreground: "#fafafa",
    mutedForeground: "#a3a3a3",
    danger: "#ff5f57",
    success: "#28c840",
  },
  spacing: 16,
  radius: 12,
};

const c = theme.colors;

export const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: c.background,
  },
  container: {
    flex: 1,
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: c.foreground,
  },
  subtitle: {
    fontSize: 14,
    color: c.mutedForeground,
  },
  label: {
    fontSize: 12,
    color: c.mutedForeground,
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  card: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    padding: 16,
    gap: 6,
  },
  mono: {
    fontFamily: "monospace",
    fontSize: 13,
    color: c.foreground,
  },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: c.foreground,
  },
  error: {
    color: c.danger,
    fontSize: 13,
  },
  hint: {
    fontSize: 12,
    color: c.mutedForeground,
  },
});