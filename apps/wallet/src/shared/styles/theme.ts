import { StyleSheet } from "./stylesheet";

// PeridotID brand theme — mirrors the PeridotVault marketing system (brand.md):
// peridot green on near-black, Space Grotesk, square corners.

export const theme = {
  colors: {
    background: "#0d0f0e",
    surface: "#060807",
    card: "#060807",
    cardForeground: "#e0e4e4",
    popover: "#060807",
    popoverForeground: "#e0e4e4",
    muted: "#363636",
    elevated: "#1b1e1c",
    border: "#ffffff28",
    input: "#ffffff28",
    line: "#ffffff14",
    foreground: "#e0e4e4",
    paragraph: "#b5b5b5",
    label: "#ffffff60",
    mutedForeground: "#a3a3a3",
    primary: "#349b65",
    primaryForeground: "#0a0c0b",
    secondary: "#349b6650",
    secondaryForeground: "#e0e4e4",
    accent: "#87ee83",
    accentForeground: "#0a0c0b",
    ring: "#87ee83",
    danger: "#ff5f57",
    dangerTint: "#2a1413",
    destructive: "#ff5f57",
    destructiveForeground: "#0d0f0e",
    success: "#87ee83",
  },
  spacing: 16,
  // Radius lives in tokens.css (`--radius-sm|md|lg|xl` = 6/8/10/14), the
  // peridotbase scale shared with the dashboard; screens use those classes.
  // App column cap (sm, 576px): every wallet screen centers inside this.
  // No-op on phones (<576pt); constrains + centers on wide web.
  // Past the md breakpoint the tab bar docks left as a sidebar instead.
  // The whole wallet frame caps wider (frameMaxWidth) while content stays sm.
  layout: { maxWidth: 576, sidebarBreakpoint: 768, sidebarWidth: 232, threeColumnBreakpoint: 1280, navWidth: 240, infoWidth: 300, frameMaxWidth: 232 + 576, threeColMaxWidth: 1164 },
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

export const styles = StyleSheet.create({
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
  // Desktop frame: the sidebar and the content column are ONE centered block
  // (232 + 576), so the nav never hugs the window edge while the column floats
  // in the middle of the viewport.
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
});