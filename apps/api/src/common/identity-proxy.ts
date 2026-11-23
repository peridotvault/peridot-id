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

function readBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export type IdentityProxy = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function identityProxy(
  target: string,
  fetchImpl: typeof fetch = fetch,
  network: "mainnet" | "testnet" = "testnet",
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
    try {
      const upstream = await fetchImpl(`${target}${req.originalUrl}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: new Uint8Array(await readBody(req)) } : {}),
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
