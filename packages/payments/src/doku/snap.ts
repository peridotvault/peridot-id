// SNAP signing helpers (B2B token + symmetric HMAC-SHA512 calls).
// Docs: developers.doku.com — B2B token uses RSA SHA256withRSA over
// `clientId|X-TIMESTAMP`; API calls use HMAC-SHA512 over
// `METHOD:EndpointUrl:AccessToken:lower(hex(sha256(minify(body)))):Timestamp`.

import { createHash, createHmac, createSign } from "node:crypto";

/** SNAP timestamps: `YYYY-MM-DDTHH:mm:ss+07:00` (DOKU local, not UTC Z). */
export function snapTimestamp(d = new Date()): string {
  const wib = new Date(d.getTime() + (7 * 60 + d.getTimezoneOffset()) * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${wib.getFullYear()}-${pad(wib.getMonth() + 1)}-${pad(wib.getDate())}` +
    `T${pad(wib.getHours())}:${pad(wib.getMinutes())}:${pad(wib.getSeconds())}+07:00`
  );
}

export function sha256HexLower(minifiedBody: string): string {
  return createHash("sha256").update(minifiedBody).digest("hex").toLowerCase();
}

/** Symmetric SNAP signature for payout calls (HMAC-SHA512, base64). */
export function snapSignature(opts: {
  method: string;
  endpointUrl: string;
  accessToken: string;
  minifiedBody: string;
  timestamp: string;
  clientSecret: string;
}): string {
  const stringToSign = [
    opts.method,
    opts.endpointUrl,
    opts.accessToken,
    sha256HexLower(opts.minifiedBody),
    opts.timestamp,
  ].join(":");
  return createHmac("sha512", opts.clientSecret).update(stringToSign).digest("base64");
}

/** Asymmetric B2B signature: RSA-SHA256 over `clientId|X-TIMESTAMP`. */
export function b2bSignature(clientId: string, timestamp: string, privateKeyPem: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(`${clientId}|${timestamp}`);
  signer.end();
  return signer.sign({ key: privateKeyPem }, "base64");
}

export function snapExternalId(): string {
  // Numeric string, unique per day — timestamp + random digits.
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`.slice(0, 32);
}

export function snapHeaders(opts: {
  partnerId: string;
  externalId?: string;
  timestamp?: string;
  channelId?: string;
  accessToken?: string;
  signature: string;
}): Record<string, string> {
  const h: Record<string, string> = {
    "X-PARTNER-ID": opts.partnerId,
    "X-EXTERNAL-ID": opts.externalId ?? snapExternalId(),
    "X-TIMESTAMP": opts.timestamp ?? snapTimestamp(),
    "X-SIGNATURE": opts.signature,
    "CHANNEL-ID": opts.channelId ?? "07",
    "Content-Type": "application/json",
  };
  if (opts.accessToken) h.Authorization = `Bearer ${opts.accessToken}`;
  return h;
}

/** `value` must carry 2 decimals per SNAP (`10000` → `"10000.00"`). */
export function snapAmount(idrWhole: bigint | number | string): string {
  return `${BigInt(idrWhole).toString()}.00`;
}
