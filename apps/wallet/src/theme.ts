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
    dangerTint: "#2a1413",
    success: "#28c840",
  },
  spacing: 16,
  // Web feel: sharp cut-corner aesthetic — radius 0 everywhere (circular
  // avatars/dots keep their own inline radii).
  radius: 0,
  fonts: {
    sans: "Geist_400Regular",
    sansMedium: "Geist_500Medium",
    sansSemiBold: "Geist_600SemiBold",
    sansBold: "Geist_700Bold",
    serif: "SourceSerif4_400Regular",
    mono: "JetBrainsMono_400Regular",
  },
};

const c = theme.colors;
const f = theme.fonts;

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
    fontFamily: f.sansBold,
    letterSpacing: -0.3,
    color: c.foreground,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: f.sans,
    color: c.mutedForeground,
  },
  label: {
    fontSize: 12,
    color: c.mutedForeground,
    fontWeight: "500",
    fontFamily: f.sansMedium,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  card: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 0,
    padding: 16,
    gap: 6,
  },
  mono: {
    fontFamily: f.mono,
    fontSize: 13,
    color: c.foreground,
  },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    borderRadius: 0,
    padding: 12,
    fontSize: 15,
    fontFamily: f.sans,
    color: c.foreground,
  },
  error: {
    color: c.danger,
    fontSize: 13,
    fontFamily: f.sans,
  },
  hint: {
    fontSize: 12,
    fontFamily: f.sans,
    color: c.mutedForeground,
  },
});