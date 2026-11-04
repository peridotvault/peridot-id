// Weak ETag + revalidation for GET JSON reads.
//
// Why: every SDK GET re-downloaded a full body even when nothing had changed.
// With an ETag the browser (and any HTTP client) revalidates for free: a `304`
// carries no body and the API does no serialization work beyond the handler.
//
// Deliberately conservative:
// * GET only — mutations must never be cached.
// * `Cache-Control: private, no-cache` (revalidate every time, no shared
//   caches) unless the route already set its own header (public registries).
// * `Vary: Cookie, Authorization` so a shared cache can never hand one user's
//   body to another.
// * Skips redirects, binary/stream bodies and the auth cookie ceremonies.

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { Observable, map } from "rxjs";
import { StreamableFile } from "@nestjs/common";

/** Paths whose response depends on a cookie ceremony, not on resource state. */
const SKIP_PREFIXES = ["/v1/auth/google"];

function isCacheableBody(body: unknown): boolean {
  if (body === undefined || body === null) return false;
  if (Buffer.isBuffer(body)) return false;
  if (body instanceof StreamableFile) return false;
  const type = typeof body;
  return type === "object" || type === "string" || type === "number" || type === "boolean";
}

/** `W/"<sha1 of the JSON body>"` — weak: semantic equality is enough here. */
export function weakEtag(body: unknown): string {
  const digest = createHash("sha1").update(JSON.stringify(body) ?? "").digest("base64url");
  return `W/"${digest}"`;
}

@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<{ method?: string; url?: string; headers?: Record<string, unknown> }>();
    if (req.method !== "GET") return next.handle();

    const path = (req.url ?? "").split("?")[0];
    if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return next.handle();

    return next.handle().pipe(
      map((body) => {
        const res = http.getResponse<{
          statusCode?: number;
          setHeader(name: string, value: string): void;
          getHeader(name: string): unknown;
          status(code: number): unknown;
        }>();
        if (!isCacheableBody(body)) return body;
        if ((res.statusCode ?? 200) !== 200) return body;

        const tag = weakEtag(body);
        res.setHeader("ETag", tag);
        if (!res.getHeader("Cache-Control")) res.setHeader("Cache-Control", "private, no-cache");
        if (!res.getHeader("Vary")) res.setHeader("Vary", "Cookie, Authorization");

        const inm = req.headers?.["if-none-match"];
        const ifNoneMatch = Array.isArray(inm) ? inm.join(",") : String(inm ?? "");
        if (ifNoneMatch.split(",").some((t) => t.trim() === tag)) {
          res.status(304);
          return undefined;
        }
        return body;
      }),
    );
  }
}
