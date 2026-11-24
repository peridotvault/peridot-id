import type { Screen } from "../hooks/useSessionBootstrap";

// One URL per screen. The wallet has no router library: the shell owns the
// screen state and mirrors it into the address bar, so a page is linkable and
// the browser's back button works. Detail screens need an item the URL cannot
// carry, so a cold load of one lands on its list instead.
const PATH: Record<Screen, string> = {
  login: "/",
  home: "/",
  provisioning: "/setup",
  send: "/send",
  receive: "/receive",
  swap: "/swap",
  topup: "/topup",
  activity: "/activity",
  "activity-detail": "/activity",
  "fiat-account": "/rupiah",
  "fiat-detail": "/rupiah",
  "fiat-ledger-detail": "/rupiah",
  "fiat-transfer": "/rupiah/send",
  passkey: "/passkeys",
  chains: "/chains",
  settings: "/settings",
  profile: "/profile",
  "edit-profile": "/profile/edit",
  sessions: "/sessions",
  connected: "/connected",
  "app-connections": "/apps",
};

// Reverse map written out (several screens share a path, so Object.entries
// order would decide the winner). Unknown paths return null, never a guess.
const SCREEN_BY_PATH: Record<string, Screen> = {
  "/": "home",
  "/setup": "provisioning",
  "/send": "send",
  "/receive": "receive",
  "/swap": "swap",
  "/topup": "topup",
  "/activity": "activity",
  "/rupiah": "fiat-account",
  "/rupiah/send": "fiat-transfer",
  "/passkeys": "passkey",
  "/chains": "chains",
  "/settings": "settings",
  "/profile": "profile",
  "/profile/edit": "edit-profile",
  "/sessions": "sessions",
  "/connected": "connected",
  "/apps": "app-connections",
};

/** URL for a screen (shared paths collapse to the same address). */
export function pathOf(screen: Screen): string {
  return PATH[screen];
}

/** Screen for a path, or null when the address belongs to nobody. */
export function screenOf(pathname: string): Screen | null {
  return SCREEN_BY_PATH[pathname.replace(/\/+$/, "") || "/"] ?? null;
}
