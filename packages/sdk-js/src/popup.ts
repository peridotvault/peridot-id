// Popup bridge: trust-critical ceremonies (connect, sign, approve) must run on the
// PeridotID origin inside a popup window, so the browser address bar stays visible
// as the unforgeable trust signal. This module holds both sides of the protocol:
//   - opener side (third-party dapp): openPeridotPopup / openLoginPopup
//   - hosted side (wallet app on the PeridotID origin): readPopupParams,
//     postPopupReady, awaitPopupRequest, postPopupResult
// No prod hosts here — every function takes an explicit base URL / origin
// (layering: no prod defaults in this package — caller-supplied; see the docs
// for the production hosts). Import-safe on native:
// window is only touched inside functions, which throw PopupUnavailableError
// off-browser.

export const POPUP_READY = "pid-popup-ready";
export const POPUP_REQUEST = "pid-popup-request";
export const POPUP_RESULT = "pid-popup-result";

export class PopupBlockedError extends Error {
  constructor() {
    super("Popup was blocked — allow popups for this site and try again.");
    this.name = "PopupBlockedError";
  }
}

export class PopupClosedError extends Error {
  constructor(message = "Popup was closed before completing.") {
    super(message);
    this.name = "PopupClosedError";
  }
}

export class PopupUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "PopupUnavailableError";
  }
}

export interface PopupResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

function requireBrowser(): void {
  if (typeof window === "undefined") {
    throw new PopupUnavailableError("Popups need a browser (window is undefined).");
  }
}

/** Opener-asserted origin from `?origin=`: must be an http(s) origin, else null. */
export function parsePopupOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

interface OpenerOpts {
  /** PeridotID popup host, e.g. https://app.pid.peridotvault.com (no prod default). */
  popupBaseUrl: string;
  /** Page path on the host (default "/"). */
  path?: string;
  /** Extra query params (popup action, redirect_uri, method, …). */
  params?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Open the auth page in a normal new tab (auth is a full-page flow that may go
 * through Google and the PID picker), or a centered popup for approval
 * ceremonies. `onGone` fires once on timeout or user close.
 */
function openWindow(url: string, timeoutMs: number, onGone: () => void, newTab = false): { popup: Window; cancel: () => void } {
  requireBrowser();
  let popup: Window | null;
  if (newTab) {
    popup = window.open(url, "_blank");
  } else {
    const w = 420;
    const h = 640;
    const left = Math.max(0, (window.screenX ?? 0) + ((window.innerWidth ?? w) - w) / 2);
    const top = Math.max(0, (window.screenY ?? 0) + ((window.innerHeight ?? h) - h) / 2);
    popup = window.open(url, "peridot-popup", `width=${w},height=${h},left=${left},top=${top},popup=1`);
  }
  if (!popup) throw new PopupBlockedError();
  let done = false;
  const cancel = () => {
    done = true;
    clearTimeout(timer);
    clearInterval(poll);
  };
  const timer = setTimeout(() => {
    if (done) return;
    cancel();
    onGone();
  }, timeoutMs);
  const poll = setInterval(() => {
    if (done || !popup.closed) return;
    cancel();
    onGone();
  }, 400);
  return { popup, cancel };
}

function buildPopupUrl(opts: OpenerOpts): { url: string; origin: string } {
  const origin = new URL(opts.popupBaseUrl).origin;
  const url = new URL(opts.path ?? "/", origin);
  for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  return { url: url.toString(), origin };
}

/**
 * Generic opener: run one trust-critical action on the PeridotID origin.
 * Handshake: popup posts READY → opener posts REQUEST → popup posts RESULT.
 * Rejects on block / close / timeout / explicit deny.
 */
export async function openPeridotPopup<T>(opts: OpenerOpts & { request: { action: string; payload?: unknown } }): Promise<T> {
  requireBrowser();
  const selfOrigin = window.location.origin;
  const { url, origin } = buildPopupUrl({ ...opts, params: { ...opts.params, origin: selfOrigin } });
  return new Promise<T>((resolve, reject) => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== popup || e.origin !== origin) return;
      const msg = e.data as { type?: unknown } & Partial<PopupResult<T>>;
      if (msg?.type === POPUP_READY) {
        popup.postMessage({ type: POPUP_REQUEST, request: opts.request }, origin);
      } else if (msg?.type === POPUP_RESULT) {
        finish(() => {
          if (msg.ok) resolve(msg.data as T);
          else reject(new Error(msg.error || "Request was rejected."));
        });
      }
    };
    const { popup, cancel } = openWindow(url, opts.timeoutMs ?? 120_000, () => {
      window.removeEventListener("message", onMessage);
      reject(new PopupClosedError());
    });
    const finish = (fn: () => void): void => {
      cancel();
      window.removeEventListener("message", onMessage);
      try {
        popup.close();
      } catch {
        // already gone
      }
      fn();
    };
    window.addEventListener("message", onMessage);
  });
}

/**
 * Login opener: opens the PeridotID auth page in a NEW TAB (auth is a full-page
 * flow — Google + PID picker — and must not be a cramped popup). No handshake:
 * the tab goes to Google and, on return, the hosted page mints a pid_code for
 * this app (using our origin + clientId) and posts it back via `window.opener`.
 * Resolves with { pidCode }.
 */
export async function openLoginTab(opts: OpenerOpts): Promise<{ pidCode?: string }> {
  requireBrowser();
  const selfOrigin = window.location.origin;
  const { url, origin } = buildPopupUrl(opts);
  return new Promise<{ pidCode?: string }>((resolve, reject) => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== popup) return;
      if (e.origin !== origin && e.origin !== selfOrigin) return;
      const msg = e.data as { type?: unknown } & Partial<PopupResult<{ pidCode?: string }>>;
      if (msg?.type !== POPUP_RESULT) return;
      finish(() => {
        if (msg.ok) resolve(msg.data ?? {});
        else reject(new Error(msg.error || "Sign-in was rejected."));
      });
    };
    const { popup, cancel } = openWindow(url, opts.timeoutMs ?? 300_000, () => {
      window.removeEventListener("message", onMessage);
      reject(new PopupClosedError());
    }, true);
    const finish = (fn: () => void): void => {
      cancel();
      window.removeEventListener("message", onMessage);
      try {
        popup.close();
      } catch {
        // already gone
      }
      fn();
    };
    window.addEventListener("message", onMessage);
  });
}

/** @deprecated Use {@link openLoginTab}. Kept as an alias for existing apps. */
export const openLoginPopup = openLoginTab;

/**
 * Dapp-in-popup side: after an OAuth round-trip lands back on the dapp URL
 * inside the popup with `?pid_code=`, forward it to the opener and close.
 * Returns true when it handled the code (caller should render nothing).
 */
export function forwardPopupLoginCode(param = "pid_code"): boolean {
  if (typeof window === "undefined" || !window.opener) return false;
  try {
    const code = new URLSearchParams(window.location.search).get(param);
    if (!code) return false;
    window.opener.postMessage({ type: POPUP_RESULT, ok: true, data: { pidCode: code } }, window.location.origin);
    window.close();
    return true;
  } catch {
    return false;
  }
}

export interface PopupParams {
  /** Action the popup must perform: "login" or a sign action (withdraw, …). */
  action: string;
  /** Opener-asserted origin results are posted back to (validated http(s)). */
  origin: string;
  /** Login hint: which method to auto-start ("google" | "passkey"). */
  method?: string;
  /** Registered app this login is for (binds the issued pid_code). */
  clientId?: string;
}

/** Hosted side: parse `?popup=<action>&origin=<origin>&method=…&client_id=…`. */
export function readPopupParams(): PopupParams | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search);
    const action = q.get("popup") ?? "";
    const origin = parsePopupOrigin(q.get("origin"));
    if (!action || !origin) return null;
    const method = q.get("method") ?? undefined;
    const clientId = q.get("client_id") ?? undefined;
    return {
      action,
      origin,
      ...(method ? { method } : {}),
      ...(clientId ? { clientId } : {}),
    };
  } catch {
    return null;
  }
}

/** Hosted side: tell the opener we're ready for the request handshake. */
export function postPopupReady(targetOrigin: string): void {
  requireBrowser();
  if (!window.opener) throw new PopupUnavailableError("No opener — open this page from a dapp popup.");
  window.opener.postMessage({ type: POPUP_READY }, targetOrigin);
}

/** Hosted side: wait for the opener's REQUEST (origin + source validated). */
export async function awaitPopupRequest(targetOrigin: string, timeoutMs = 30_000): Promise<{ action: string; payload?: unknown }> {
  requireBrowser();
  if (!window.opener) throw new PopupUnavailableError("No opener — open this page from a dapp popup.");
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== window.opener || e.origin !== targetOrigin) return;
      const msg = e.data as { type?: unknown; request?: { action?: unknown; payload?: unknown } };
      const req = msg?.request;
      if (msg?.type !== POPUP_REQUEST || typeof req?.action !== "string") return;
      // Copy out: property narrowing doesn't survive into the closure below.
      const action: string = req.action;
      const payload: unknown = req.payload;
      finish(() => resolve({ action, payload }));
    };
    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new PopupClosedError("Popup request timed out."))), timeoutMs);
    window.addEventListener("message", onMessage);
  });
}

/** Hosted side: deliver the result to the opener and close (unless keepOpen). */
export function postPopupResult(targetOrigin: string, result: PopupResult, opts?: { keepOpen?: boolean }): void {
  requireBrowser();
  if (!window.opener) return;
  window.opener.postMessage({ type: POPUP_RESULT, ...result }, targetOrigin);
  if (!opts?.keepOpen) window.close();
}
