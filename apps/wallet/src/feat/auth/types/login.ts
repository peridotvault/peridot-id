// Shared login-flow vocabulary: the hooks hand each other these shapes, so the
// types live here instead of in one hook (importing types back and forth made
// usePidClaim ↔ useLoginSession circular).

/** Live availability of the PID claim input. */
export type HandleStatus = "idle" | "checking" | "free" | "taken" | "invalid";

// Post-auth pending claim (verified credential, no identity yet). undefined =
// still checking, null = none.
export type ClaimState = { email: string | null; displayName: string | null } | null | undefined;

export interface LoginFlowFlags {
  /** Guards the double-mint (inline deliver + effect). */
  delivered: boolean;
  /** Session presence at tab open: null = unknown, consent depends on it. */
  hadSessionAtOpen: boolean | null;
}

/** Signed-in identity shown on the consent card. `pid` keys the header read. */
export interface LoginSession {
  label: string;
  pid: string;
}
