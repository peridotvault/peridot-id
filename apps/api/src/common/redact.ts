// ANT-344 L9: log-safe renderings of PII. Raw emails and full PIDs must never
// reach server logs (log aggregation is a wider audience than the request
// path). Masked emails stay greppable by domain; pid fingerprints stay
// joinable against security events without exposing the identifier.
import { createHash } from "node:crypto";

/** `ifal@gmail.com` → `i***@gmail.com`; unparseable input → `***`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Stable non-reversible log reference for a pid: `pid:9f2c…` (12 hex chars of
 * sha256 over the lowercased pid). Same pid always renders the same token so
 * log lines correlate, but the token cannot be reversed into the identifier.
 */
export function pidLogRef(pid: string): string {
  const digest = createHash("sha256").update(pid.trim().toLowerCase(), "utf8").digest("hex");
  return `pid:${digest.slice(0, 12)}`;
}
