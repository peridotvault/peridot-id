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

/** Mint a pid_code for the app and post it to the opener, then close the tab. */
export async function deliverLoginCode(peridot: PeridotClient, ctx: LoginContext): Promise<boolean> {
  try {
    const { pidCode } = await peridot.auth.authorize({
      returnTo: ctx.origin,
      ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
    });
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
