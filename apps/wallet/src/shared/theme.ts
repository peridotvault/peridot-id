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
  // App column cap (sm, 576px): every wallet screen centers inside this.
  // No-op on phones (<576pt); constrains + centers on wide web.
  // Past the md breakpoint the tab bar docks left as a sidebar instead.
  // The whole wallet frame caps wider (frameMaxWidth) while content stays sm.
  layout: { maxWidth: 576, sidebarBreakpoint: 768, sidebarWidth: 232, frameMaxWidth: 1400 },
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
  // Shell centers the app column; column caps width at sm on wide web.
  shell: {
    flex: 1,
    alignItems: "center",
    backgroundColor: c.background,
  },
  column: {
    width: "100%",
    maxWidth: theme.layout.maxWidth,
    flex: 1,
  },
  // Frame caps the whole wallet on very wide windows; the row holds the
  // sidebar slot + content area, which centers the sm column in the remainder.
  frame: {
    width: "100%",
    maxWidth: theme.layout.frameMaxWidth,
    flex: 1,
  },
  wideRow: {
    flexDirection: "row",
    flex: 1,
  },
  contentWrap: {
    flex: 1,
    alignItems: "center",
  },
  // Stack box: relative content area the push overlay covers. Same sm cap as
  // the column so the overlay never exceeds the content section.
  stackBox: {
    flex: 1,
    width: "100%",
    maxWidth: theme.layout.maxWidth,
  },
  // Opaque cover over the content box only — TopBar/sidebar stay visible.
  // (Push roots use s.container with no bg of their own, so the wrapper
  // provides the opacity.)
  overlay: {
    ...StyleSheet.absoluteFillObject,
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