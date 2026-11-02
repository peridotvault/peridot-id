import { StyleSheet } from "./stylesheet";

// PeridotID brand theme — mirrors the PeridotVault marketing system (brand.md):
// peridot green on near-black, Space Grotesk, square corners.

export const theme = {
  colors: {
    background: "#0d0f0e",
    surface: "#060807",
    card: "#060807",
    muted: "#363636",
    border: "#ffffff28",
    line: "#ffffff14",
    foreground: "#e0e4e4",
    paragraph: "#b5b5b5",
    label: "#ffffff60",
    mutedForeground: "#7d7d7d",
    primary: "#349b65",
    secondary: "#349b6650",
    accent: "#87ee83",
    danger: "#ff5f57",
    dangerTint: "#2a1413",
    success: "#87ee83",
  },
  spacing: 16,
  // Web feel: sharp cut-corner aesthetic — radius 0 everywhere (circular
  // avatars/dots keep their own inline radii).
  radius: 0,
  // App column cap (sm, 576px): every wallet screen centers inside this.
  // No-op on phones (<576pt); constrains + centers on wide web.
  // Past the md breakpoint the tab bar docks left as a sidebar instead.
  // The whole wallet frame caps wider (frameMaxWidth) while content stays sm.
  layout: { maxWidth: 576, sidebarBreakpoint: 768, sidebarWidth: 232, threeColumnBreakpoint: 1280, navWidth: 240, infoWidth: 300, frameMaxWidth: 1400, threeColMaxWidth: 1164 },
  fonts: {
    // Single variable families (Google Fonts <link> in index.html) — weight
    // comes from fontWeight at each call site, not the family name.
    sans: "'Space Grotesk', system-ui, -apple-system, sans-serif",
    sansMedium: "'Space Grotesk', system-ui, -apple-system, sans-serif",
    sansSemiBold: "'Space Grotesk', system-ui, -apple-system, sans-serif",
    sansBold: "'Space Grotesk', system-ui, -apple-system, sans-serif",
    // Money and other changing figures — tabular by nature.
    mono: "'JetBrains Mono', ui-monospace, monospace",
  },
};

const c = theme.colors;
const f = theme.fonts;

export const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: c.background,
  },
  // Shell centers the app column; column caps width at sm on wide web. The
  // page (document) scrolls — nothing here locks a viewport height, so the
  // window owns the scrollbar and the content column never grows its own.
  shell: {
    alignItems: "center",
    backgroundColor: c.background,
    minHeight: "100dvh",
  },
  // The single owner of the vertical frame lines (brand.md). Everything the
  // screen renders lives inside this box; nothing nested may draw its own.
  rail: {
    width: "100%",
    maxWidth: theme.layout.maxWidth,
    // Never shorter than the viewport, so the frame lines run the full page.
    minHeight: "100dvh",
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: c.line,
  },
  // Frame caps the whole wallet on very wide windows; the row holds the
  // sidebar slot + content area, which centers the sm column in the remainder.
  frame: {
    width: "100%",
    maxWidth: theme.layout.frameMaxWidth,
    minHeight: "100dvh",
  },
  wideRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: "100dvh",
  },
  // Three-column desktop frame: nav | content rail | info. Columns are sticky
  // (fixed to the top while the page scrolls); only a column whose own content
  // is taller than the viewport gets an inner scrollbar.
  threeCol: {
    flexDirection: "row",
    alignItems: "flex-start",
    width: "100%",
    maxWidth: theme.layout.threeColMaxWidth,
    gap: 24,
    minHeight: "100dvh",
  },
  // Sticky side column: pinned to the top, scrolls on its own only if needed.
  stickyCol: {
    position: "sticky",
    top: 0,
    alignSelf: "flex-start",
    maxHeight: "100dvh",
    overflowY: "auto",
  },
  contentWrap: {
    flex: 1,
    alignItems: "center",
    minWidth: 0,
  },
  // Content column: plain flow, grows with the page.
  stackBox: {
    width: "100%",
    maxWidth: theme.layout.maxWidth,
    position: "relative",
  },
  // Full-shell cover for pushes: fixed to the viewport with its own scroll, so
  // a long page behind it can't drag the overlay around.
  rootFill: {
    width: "100%",
    minHeight: "100dvh",
    position: "relative",
  },
  overlayFull: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 40,
    overflowY: "auto",
    backgroundColor: c.background,
    alignItems: "center",
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
  // Row/block rule (brand.md): a top hairline that runs rail to rail. Containers
  // own the lines, so the row carries its own horizontal padding.
  card: {
    borderTopWidth: 1,
    borderColor: c.line,
    paddingVertical: 12,
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
    // 16px floor: prevents iOS Safari auto-zoom on focus (ANT-341 FR2).
    fontSize: 16,
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