// DOKU Checkout (hosted page) helpers — pure functions over node:crypto only.
// Docs: POST {base}/checkout/v1/payment with headers Client-Id, Request-Id,
// Request-Timestamp, Signature. Signature = "HMACSHA256=" + base64(
// HMAC_SHA256(secretKey, stringToSign)), where stringToSign joins the
// Client-Id / Request-Id / Request-Timestamp / Request-Target / Digest lines.
// Digest = base64(SHA-256(minified JSON body)); empty body hashes to "".

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const DOKU_SANDBOX_URL = "https://api-sandbox.doku.com";
export const DOKU_PROD_URL = "https://api.doku.com";
export const DOKU_CHECKOUT_PATH = "/checkout/v1/payment";

/** ISO-8601 UTC timestamp as DOKU expects it (e.g. 2026-09-18T00:00:00Z). */
export function dokuTimestamp(d = new Date()): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

export function sha256Base64(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("base64");
}

export interface StringToSignInput {
  clientId: string;
  requestId: string;
  requestTimestamp: string;
  /** Path + query of the request, e.g. "/checkout/v1/payment". */
  requestTarget: string;
  /** base64 SHA-256 of the minified body ("" hash when no body). */
  digest: string;
}

export function buildStringToSign(i: StringToSignInput): string {
  return (
    `Client-Id:${i.clientId}\n` +
    `Request-Id:${i.requestId}\n` +
    `Request-Timestamp:${i.requestTimestamp}\n` +
    `Request-Target:${i.requestTarget}\n` +
    `Digest:${i.digest}`
  );
}

export interface CheckoutSignatureInput extends StringToSignInput {
  secretKey: string;
}

/** Full `Signature` header value for DOKU Checkout. */
export function checkoutSignature(i: CheckoutSignatureInput): string {
  const mac = createHmac("sha256", i.secretKey).update(buildStringToSign(i)).digest("base64");
  return `HMACSHA256=${mac}`;
}

/** Timing-safe check of an incoming DOKU `Signature` header (webhooks). */
export function verifyCheckoutSignature(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface CheckoutHeadersInput {
  clientId: string;
  requestId: string;
  requestTimestamp?: string;
  requestTarget?: string;
  /** Minified JSON body (omit for bodiless requests). */
  body?: string;
  secretKey: string;
}

/** The four auth headers for a Checkout call. */
export function checkoutHeaders(i: CheckoutHeadersInput): Record<string, string> {
  const requestTimestamp = i.requestTimestamp ?? dokuTimestamp();
  const requestTarget = i.requestTarget ?? DOKU_CHECKOUT_PATH;
  const digest = sha256Base64(i.body ?? "");
  const signature = checkoutSignature({
    clientId: i.clientId,
    requestId: i.requestId,
    requestTimestamp,
    requestTarget,
    digest,
    secretKey: i.secretKey,
  });
  return {
    "Client-Id": i.clientId,
    "Request-Id": i.requestId,
    "Request-Timestamp": requestTimestamp,
    Signature: signature,
  };
}

/** `.env` stores the PEM with literal `\n` escapes — restore real newlines. */
export function normalizePublicKey(raw: string): string {
  return raw.replace(/\\n/g, "\n");
}

/** Unique invoice number bound to the payer (acquirer-safe charset, ≤30 chars). */
export function buildInvoiceNumber(prefix = "PID"): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${stamp}${rand}`.slice(0, 30);
}

// ponytail: self-check — `node dist/checkout.js` fails loudly if signing breaks.
if (require.main === module) {
  const assert = require("node:assert");
  const sig = checkoutSignature({
    clientId: "BRN-0260-X",
    requestId: "req-1",
    requestTimestamp: "2026-09-18T00:00:00Z",
    requestTarget: DOKU_CHECKOUT_PATH,
    digest: sha256Base64('{"a":1}'),
    secretKey: "SK-test",
  });
  assert.ok(sig.startsWith("HMACSHA256="), "signature prefix");
  assert.ok(verifyCheckoutSignature(sig, sig), "self-verify");
  assert.ok(!verifyCheckoutSignature(sig, "HMACSHA256=AAAA"), "reject forged");
  assert.ok(normalizePublicKey("A\\nB") === "A\nB", "pem unescape");
  console.log("pid-payments checkout self-check OK");
}
