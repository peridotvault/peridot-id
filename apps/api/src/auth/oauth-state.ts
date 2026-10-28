// Signed OAuth `state` with a browser-bound nonce (M3).
//
// The Google `state` round-trips through the user agent, so it is attacker-
// visible and attacker-replayable. The guard wraps the login-step return
// target in an HMAC-signed envelope carrying a fresh 128-bit nonce, and drops
// that nonce in an HttpOnly cookie (10-min TTL). The callback verifies the
// signature AND the nonce match BEFORE trusting (or even decoding) the state —
// a state minted for another browser, tampered in flight, replayed after use,
// or older than 10 minutes is rejected with `invalid_state` and never reaches
// `decodeState` / `resolveReturnTo`.
//
// Standard HMAC-SHA256 with a server-side secret (OAuth-state convention, not
// a custom session scheme). Constant-time signature compare.

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** Time a signed state (and its nonce cookie) stays valid. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStatePayload {
  returnTo: string;
  clientId?: string;
  /** PKCE S256 challenge for public-client logins (M5, ANT-802) — carried
   * inside the signed envelope so the callback can bind the pid_code. */
  codeChallenge?: string;
}

/** Fresh opaque nonce for one login attempt (128-bit, single-use). */
export function newOAuthNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** Sign `{returnTo, clientId, codeChallenge, nonce}` — returns the `state` query param value. */
export function signOAuthState(
  payload: OAuthStatePayload,
  nonce: string,
  secret: string,
  nowMs: number = Date.now(),
): string {
  const body = {
    r: payload.returnTo,
    ...(payload.clientId ? { c: payload.clientId } : {}),
    ...(payload.codeChallenge ? { ch: payload.codeChallenge } : {}),
    n: nonce,
    exp: nowMs + OAUTH_STATE_TTL_MS,
  };
  const raw = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(raw).digest("base64url");
  return `${raw}.${sig}`;
}

/**
 * Verify a callback `state` against the nonce cookie and secret. Returns the
 * payload on success, null on ANY failure (missing, malformed, bad signature,
 * nonce mismatch, expired). Call this before `decodeState`, never after.
 */
export function verifyOAuthState(
  state: string | undefined,
  nonce: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): OAuthStatePayload | null {
  if (!state || !nonce) return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const raw = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(raw).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let body: { r?: unknown; c?: unknown; ch?: unknown; n?: unknown; exp?: unknown };
  try {
    body = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      r?: unknown;
      c?: unknown;
      ch?: unknown;
      n?: unknown;
      exp?: unknown;
    };
  } catch {
    return null;
  }
  if (typeof body.r !== "string" || body.r.length === 0) return null;
  if (body.n !== nonce) return null;
  if (typeof body.exp !== "number" || body.exp <= nowMs) return null;
  return {
    returnTo: body.r,
    ...(typeof body.c === "string" ? { clientId: body.c } : {}),
    ...(typeof body.ch === "string" ? { codeChallenge: body.ch } : {}),
  };
}

/**
 * Domain constant for the derived OAuth-state HMAC key (F1). Changing this
 * string invalidates all in-flight states (10-min TTL) — rotate deliberately.
 */
export const OAUTH_STATE_HKDF_INFO = "peridot-id/oauth-state/v1";

/**
 * HMAC secret for OAuth state (F1 key separation).
 *
 * A dedicated `OAUTH_STATE_SECRET` wins when set — provision it in deployed
 * envs. Otherwise the key is derived from `JWT_ACCESS_SECRET` via HKDF-SHA256
 * with a fixed domain constant, so the OAuth-state HMAC key is
 * cryptographically isolated in the direction that matters: a leak of the
 * derived key never forges JWTs and never reveals the master secret. (A
 * master-secret leak still compromises both — as before — so provision the
 * dedicated secret in deployed envs for full isolation.) Same inputs always
 * derive the same key (no per-boot randomness — sign and verify agree across
 * replicas and restarts).
 *
 * Throws when neither exists — failing closed beats signing with an empty key.
 */
export function oauthStateSecret(get: (key: string, def?: string) => unknown): string {
  const dedicated = get("OAUTH_STATE_SECRET", "") as string;
  if (dedicated) return dedicated;
  const master = get("JWT_ACCESS_SECRET", "") as string;
  if (!master) throw new Error("OAuth state secret is not configured (OAUTH_STATE_SECRET or JWT_ACCESS_SECRET)");
  return Buffer.from(hkdfSync("sha256", master, "", OAUTH_STATE_HKDF_INFO, 32)).toString("base64url");
}
