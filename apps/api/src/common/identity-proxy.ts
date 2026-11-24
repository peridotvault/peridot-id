import type { NextFunction, Request, Response } from "express";
import { identityRouteForbidden } from "./network";

/**
 * Testnet stack: identity (PID, passkey, profile, session) is owned by the
 * mainnet deployment, so its identity routes are forwarded there verbatim —
 * method, cookies, body, and the upstream `set-cookie`/`Location` come back
 * untouched. The testnet DB therefore still holds no identity rows, and the
 * wallet keeps ONE API base URL per network mode.
 *
 * Plain fetch, no proxy dependency: the route set is small and only identity
 * prefixes travel this path.
 */

/** Headers worth relaying back to the browser (hop-by-hop ones are dropped). */
const RELAY_RESPONSE_HEADERS = ["content-type", "set-cookie", "location", "cache-control", "etag"];

/** Mainnet is one hop away; a hung connection must not hang a browser request. */
const UPSTREAM_TIMEOUT_MS = 5_000;

/**
 * Cross-site login calls that name an app. An app registered in the TESTNET
 * registry (its own DB, by design) is unknown to mainnet, which would answer
 * `returnTo is not an allowed origin` / `Invalid client` — the login or code
 * exchange dies with a message about credentials the developer never touched.
 * Dropping the app binding makes such a login a first-party one: mainnet then
 * validates `returnTo` against the operator allowlist (loopback always allowed)
 * and mints the same PID session. Machine tokens stay app-bound and are minted
 * by the testnet stack itself (see LOCAL_APP_ROUTES), so app-scoped reads,
 * fees, and escrow keep working on the network the app was registered in.
 */
const APP_BOUND_ROUTES = new Set([
  "/v1/auth/login",
  "/v1/auth/passkey/finish",
  "/v1/auth/email/verify",
  "/v1/auth/authorize",
  "/v1/auth/exchange",
]);

function readBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export interface IdentityProxyOptions {
  /** True when `clientId` belongs to this stack's own app registry. */
  localApp?: (clientId: string) => Promise<boolean>;
  /** Called once per stripped call (route + clientId) for ops visibility. */
  onUnbound?: (path: string, clientId: string) => void;
}

/** Body without the app binding, or null when this call is not app-bound here. */
async function unboundBody(
  raw: Buffer,
  isLocalApp: (clientId: string) => Promise<boolean>,
): Promise<{ clientId: string; body: string } | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as { clientId?: unknown; clientSecret?: unknown };
  if (typeof body.clientId !== "string" || !body.clientId) return null;
  const clientId = body.clientId;
  if (!(await isLocalApp(clientId))) return null;
  delete body.clientId;
  delete body.clientSecret;
  return { clientId, body: JSON.stringify(body) };
}

export type IdentityProxy = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function identityProxy(
  target: string,
  fetchImpl: typeof fetch = fetch,
  network: "mainnet" | "testnet" = "testnet",
  opts: IdentityProxyOptions = {},
): IdentityProxy {
  const targetHost = new URL(target).host;
  return async (req, res, next) => {
    if (!identityRouteForbidden(req.path, network)) {
      next();
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && key !== "host" && key !== "content-length" && key !== "x-forwarded-for") {
        headers.set(key, value);
      }
    }
    headers.set("host", targetHost);
    // Mainnet trusts one proxy hop, so it reads the LAST XFF entry. Forwarding
    // our client's raw chain would make every testnet user look like this
    // container — one shared rate-limit bucket. Send the attested client IP.
    if (req.ip) headers.set("x-forwarded-for", req.ip);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const appBound = hasBody && APP_BOUND_ROUTES.has(req.path.replace(/\/+$/, ""));
    try {
      const raw = hasBody ? await readBody(req) : undefined;
      let body = raw ? new Uint8Array(raw) : undefined;
      if (raw && appBound && opts.localApp) {
        const unbound = await unboundBody(raw, opts.localApp);
        if (unbound) {
          // The app lives only in this stack's registry; the browser still gets a
          // normal first-party login on the network it picked.
          opts.onUnbound?.(req.path, unbound.clientId);
          body = new Uint8Array(Buffer.from(unbound.body, "utf8"));
        }
      }
      const upstream = await fetchImpl(`${target}${req.originalUrl}`, {
        method: req.method,
        headers,
        ...(body ? { body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      res.status(upstream.status);
      const setCookies = upstream.headers.getSetCookie?.() ?? [];
      if (setCookies.length > 0) res.setHeader("set-cookie", setCookies);
      for (const name of RELAY_RESPONSE_HEADERS) {
        if (name === "set-cookie") continue;
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      // Mainnet unreachable: fail closed with a plain 502, never a local session.
      res.status(502).json({ statusCode: 502, message: "Identity service unavailable" });
    }
  };
}
