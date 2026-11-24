// Testnet stack only: verify the app (machine) tokens IT minted.
//
// `POST /v1/auth/token` is served locally on the testnet stack because the app
// registry is per-network (`pid_apps` lives in each stack's DB). Mainnet
// introspection cannot validate such a token — mainnet knows neither the app
// nor this stack's signing secret — so the guard checks the local signature
// first and only falls back to introspection for user sessions, which are
// always minted by mainnet.
//
// Hand-rolled HS256 (node:crypto) on purpose: the alternative is injecting
// JwtService into a guard used by modules that never import JwtModule. Only the
// app audience is accepted, so a session/SSO token can never pass here.
import { createHmac, timingSafeEqual } from "node:crypto";
import { JWT_AUD_APP, JWT_ISSUER } from "./app-config";

export interface LocalAppToken {
  pid: string;
  app: string;
  scope?: string;
}

const decodePart = (part: string): unknown => {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

/** `{pid, app, scope?}` for a locally-signed app token, else null. Fail closed. */
export function verifyLocalAppToken(token: string, secret: string, nowMs = Date.now()): LocalAppToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts;
  const header = decodePart(rawHeader) as { alg?: unknown } | null;
  if (!header || header.alg !== "HS256") return null;

  const expected = createHmac("sha256", secret).update(`${rawHeader}.${rawPayload}`).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(rawSignature, "base64url");
  } catch {
    return null;
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

  const payload = decodePart(rawPayload) as
    | { sub?: unknown; app?: unknown; scope?: unknown; iss?: unknown; aud?: unknown; type?: unknown; exp?: unknown }
    | null;
  if (!payload) return null;
  if (payload.iss !== JWT_ISSUER || payload.aud !== JWT_AUD_APP) return null;
  if (payload.type !== "access") return null;
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  if (typeof payload.app !== "string" || !payload.app) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return null;
  return {
    pid: payload.sub,
    app: payload.app,
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
  };
}
