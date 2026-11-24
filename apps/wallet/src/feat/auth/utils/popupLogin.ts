import { deliverLoginResult, readPopupParams, type PeridotClient } from "@peridotvault/pid-sdk-js";

/**
 * Auth-in-a-new-tab context. Auth is a full-page flow (Google + PID picker) and
 * must not be a cramped popup. The context (opener origin + app client_id) is
 * read from `?popup=login&origin=…&client_id=…` and persisted in sessionStorage
 * so it survives the OAuth round-trip, which returns to CLIENT_SUCCESS_URL
 * without those query params. When auth (and, for new users, PID creation)
 * completes, the window mints a pid_code for the app and posts it to the opener.
 */
export interface LoginContext {
  origin: string;
  clientId?: string;
  /**
   * The app's `?redirect_uri=`: the code is minted for this exact URL, and it is
   * the fallback target when the opener is gone (no postMessage possible).
   */
  redirectUri?: string;
  method?: string;
  /** First-party opener (PeridotID-owned page): authenticate + close, no pid_code. */
  firstParty?: boolean;
  /** First-party opener's session namespace — mint its own session cookies. */
  sessionScope?: string;
}

const KEY = "pid_login_ctx";
/** This tab's session was created by an explicit login here (survives OAuth). */
const EXPLICIT_KEY = "pid_login_explicit";

export function readLoginContext(): LoginContext | null {
  if (typeof window === "undefined") return null;
  const p = readPopupParams();
  if (p && p.action === "login") {
    // A fresh request from a dapp is never an explicit-login continuation: a
    // stale flag from an abandoned flow must not skip the consent card.
    clearExplicitLogin();
    const ctx: LoginContext = {
      origin: p.origin,
      ...(p.redirectUri ? { redirectUri: p.redirectUri } : {}),
      ...(p.clientId ? { clientId: p.clientId } : {}),
      ...(p.method ? { method: p.method } : {}),
      ...(p.firstParty ? { firstParty: true } : {}),
      ...(p.sessionScope ? { sessionScope: p.sessionScope } : {}),
    };
    try {
      sessionStorage.setItem(KEY, JSON.stringify(ctx));
    } catch {
      // private mode / storage disabled — delivery still works this load
    }
    return ctx;
  }
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as LoginContext;
  } catch {
    // ignore
  }
  return null;
}

export function clearLoginContext(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  clearExplicitLogin();
}

/**
 * "This tab's session came from a login I just did here" — persisted because a
 * full-page OAuth round-trip remounts the app, and the in-memory flags die. The
 * consent card must not reappear for a session the user created in this tab
 * (it still appears for a session that was already there when the tab opened).
 */
export function markExplicitLogin(): void {
  try {
    sessionStorage.setItem(EXPLICIT_KEY, "1");
  } catch {
    // private mode / storage disabled — worst case one extra consent tap
  }
}

export function isExplicitLogin(): boolean {
  try {
    return sessionStorage.getItem(EXPLICIT_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearExplicitLogin(): void {
  try {
    sessionStorage.removeItem(EXPLICIT_KEY);
  } catch {
    // ignore
  }
}

/** Nudge sibling wallet tabs to re-check the session (same-origin localStorage). */
function pingWalletTabs(): void {
  try {
    window.localStorage.setItem("pid_session_ping", String(Date.now()));
  } catch {
    // private mode / storage disabled — focus-based recheck still covers it
  }
}

/**
 * Why a verified sign-in still handed nothing back: the app refused a code
 * (unverified, or its returnTo is not registered). Shared so the picker, the
 * passkey path and the email path cannot each invent their own silence.
 */
export const APP_REFUSED_MESSAGE =
  "Signed in, but this app can't receive a session yet — it may not be verified. Retry from the app once its owner approves it.";

/** Mint a pid_code for the app and hand it to the opener, then close the window. */
export async function deliverLoginCode(peridot: PeridotClient, ctx: LoginContext): Promise<boolean> {
  // First-party opener: mint its OWN session (so app logout never touches the
  // wallet), then confirm and close. No pid_code either way.
  if (ctx.firstParty) {
    if (ctx.sessionScope) {
      const ok = await peridot.auth.grantSession(ctx.sessionScope);
      if (!ok) {
        deliverLoginResult(ctx.origin, { ok: false, error: "Couldn't start the app session — try again." }, ctx.redirectUri);
        return false;
      }
    }
    pingWalletTabs();
    deliverLoginResult(ctx.origin, { ok: true }, ctx.redirectUri);
    clearLoginContext();
    return true;
  }
  try {
    const { pidCode } = await peridot.auth.authorize({
      returnTo: ctx.redirectUri ?? ctx.origin,
      ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
    });
    pingWalletTabs();
    deliverLoginResult(ctx.origin, { ok: true, data: { pidCode } }, ctx.redirectUri);
    clearLoginContext();
    return true;
  } catch {
    return false;
  }
}

/** Tell the opener the user declined / abandoned (e.g. cancelled PID creation). */
export function rejectLogin(ctx: LoginContext, error = "access_denied"): void {
  deliverLoginResult(ctx.origin, { ok: false, error }, ctx.redirectUri);
  clearLoginContext();
}
