import { postPopupResult, readPopupParams, type PeridotClient } from "@peridotvault/pid-sdk-js";

/**
 * Auth-in-a-new-tab context. Auth is a full-page flow (Google + PID picker) and
 * must not be a cramped popup. The context (opener origin + app client_id) is
 * read from `?popup=login&origin=…&client_id=…` and persisted in sessionStorage
 * so it survives the OAuth round-trip, which returns to CLIENT_SUCCESS_URL
 * without those query params. When auth (and, for new users, PID creation)
 * completes, the tab mints a pid_code for the app and posts it to the opener.
 */
export interface LoginContext {
  origin: string;
  clientId?: string;
  method?: string;
  /** First-party opener (PeridotID-owned page): authenticate + close, no pid_code. */
  firstParty?: boolean;
  /** First-party opener's session namespace — mint its own session cookies. */
  sessionScope?: string;
}

const KEY = "pid_login_ctx";

export function readLoginContext(): LoginContext | null {
  if (typeof window === "undefined") return null;
  const p = readPopupParams();
  if (p && p.action === "login") {
    const ctx: LoginContext = {
      origin: p.origin,
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
}

/** Nudge sibling wallet tabs to re-check the session (same-origin localStorage). */
function pingWalletTabs(): void {
  try {
    window.localStorage.setItem("pid_session_ping", String(Date.now()));
  } catch {
    // private mode / storage disabled — focus-based recheck still covers it
  }
}

/** Mint a pid_code for the app and post it to the opener, then close the tab. */
export async function deliverLoginCode(peridot: PeridotClient, ctx: LoginContext): Promise<boolean> {
  // First-party opener: mint its OWN session (so app logout never touches the
  // wallet), then confirm and close. No pid_code either way.
  if (ctx.firstParty) {
    if (ctx.sessionScope) {
      const ok = await peridot.auth.grantSession(ctx.sessionScope);
      if (!ok) {
        postPopupResult(ctx.origin, { ok: false, error: "Couldn't start the app session — try again." });
        return false;
      }
    }
    pingWalletTabs();
    postPopupResult(ctx.origin, { ok: true });
    clearLoginContext();
    return true;
  }
  try {
    const { pidCode } = await peridot.auth.authorize({
      returnTo: ctx.origin,
      ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
    });
    pingWalletTabs();
    postPopupResult(ctx.origin, { ok: true, data: { pidCode } });
    clearLoginContext();
    return true;
  } catch {
    return false;
  }
}

/** Tell the opener the user declined / abandoned (e.g. cancelled PID creation). */
export function rejectLogin(ctx: LoginContext, error = "access_denied"): void {
  postPopupResult(ctx.origin, { ok: false, error });
  clearLoginContext();
}
