// Browser WebAuthn passkey integration (task 009). Provides the PasskeySigner the Solana
// adapter needs, plus the registration ceremony client for the credentials API (task 003).

import { b64url, b64urlToBytes, derToRawEcdsa } from "@peridotvault/pid-solana";
import type { PasskeyAssertion, PasskeySigner } from "@peridotvault/pid-solana";
import type {
  Authority,
  RegisterStart,
} from "@peridotvault/pid-types";

function bytesOf(v: ArrayBuffer | ArrayBufferView): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.slice().buffer as ArrayBuffer;
}

function credResponseToJson(c: PublicKeyCredential): {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string };
} {
  const r = c.response as AuthenticatorAttestationResponse;
  return {
    id: c.id,
    rawId: b64url(bytesOf(c.rawId)),
    type: c.type ?? "public-key",
    response: {
      clientDataJSON: b64url(bytesOf(r.clientDataJSON)),
      attestationObject: b64url(bytesOf(r.attestationObject)),
    },
  };
}

/** Passkey signer backed by `navigator.credentials.get` (WebAuthn, secp256r1/ES256). */
export class BrowserPasskeySigner implements PasskeySigner {
  async sign(challenge: Uint8Array, opts: { allowCredentialId?: string } = {}): Promise<PasskeyAssertion> {
    if (typeof navigator === "undefined" || !navigator.credentials) {
      throw new Error("WebAuthn is not available on this device");
    }
    const allowCredentials = opts.allowCredentialId
      ? [{ type: "public-key" as PublicKeyCredentialType, id: toArrayBuffer(b64urlToBytes(opts.allowCredentialId)) }]
      : undefined;
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: toArrayBuffer(challenge),
        rpId: window.location.hostname,
        allowCredentials,
        userVerification: "required",
      },
    })) as PublicKeyCredential;
    if (!cred) throw new Error("Passkey authentication cancelled");

    const response = cred.response as AuthenticatorAssertionResponse;
    return {
      credentialId: cred.id,
      signature: derToRawEcdsa(bytesOf(response.signature)),
      authenticatorData: bytesOf(response.authenticatorData),
      clientDataJSON: bytesOf(response.clientDataJSON),
    };
  }
}

/** Register a passkey via the credentials API (task 003) — drives the WebAuthn create. */
export async function registerPasskey(api: {
  registerStart(): Promise<RegisterStart | ApiErrorLike>;
  registerFinish(input: unknown): Promise<Authority | ApiErrorLike>;
}): Promise<Authority> {
  const start = await api.registerStart();
  if (isApiError(start)) throw new Error((start as { message: string }).message);

  // First credential: plain create. Additional credential: also assert with an existing
  // passkey (approval) — ADR 006 §4.
  let approval: unknown;
  let credential: PublicKeyCredential;
  const publicKey = toCreationOptions(start.options as Record<string, unknown>);
  try {
    credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential;
  } catch (err) {
    throw mapWebAuthnError(err as DOMException, "add");
  }
  if (!credential) throw new Error("Passkey registration cancelled");

  if (start.isAdditional && start.approval) {
    try {
      approval = await navigator.credentials.get({
        publicKey: toRequestOptions(start.approval as Record<string, unknown>),
      });
    } catch (err) {
      throw mapWebAuthnError(err as DOMException, "approve");
    }
  }

  const finish = await api.registerFinish({
    registrationId: start.registrationId,
    credential: credResponseToJson(credential),
    approval: approval ? toAssertionJson(approval as PublicKeyCredential) : undefined,
  });
  if (isApiError(finish)) throw new Error((finish as { message: string }).message);
  return finish as Authority;
}

/** Authenticate with a passkey (sign-in) — drives the WebAuthn get via the auth API. */
export async function authenticatePasskey(api: {
  start(): Promise<{ authenticationId: string; options: Record<string, unknown> } | ApiErrorLike>;
  finish(input: { authenticationId: string; credential: unknown }): Promise<{ ok: boolean } | ApiErrorLike>;
}): Promise<{ ok: true }> {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new Error("WebAuthn is not available on this device");
  }
  const start = await api.start();
  if (isApiError(start)) throw new Error((start as { message: string }).message);

  const publicKey = toRequestOptions(start.options as Record<string, unknown>);
  let credential: PublicKeyCredential;
  try {
    credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential;
  } catch (err) {
    throw mapWebAuthnError(err as DOMException, "login");
  }
  if (!credential) throw new Error("Passkey authentication cancelled");

  const finish = await api.finish({
    authenticationId: start.authenticationId,
    credential: toAssertionJson(credential),
  });
  if (isApiError(finish)) throw new Error((finish as { message: string }).message);
  return { ok: true };
}

function toAssertionJson(a: PublicKeyCredential): {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string };
} {
  const r = a.response as AuthenticatorAssertionResponse;
  return {
    id: a.id,
    rawId: b64url(bytesOf(a.rawId)),
    type: a.type ?? "public-key",
    response: {
      clientDataJSON: b64url(bytesOf(r.clientDataJSON)),
      authenticatorData: b64url(bytesOf(r.authenticatorData)),
      signature: b64url(bytesOf(r.signature)),
    },
  };
}

interface ApiErrorLike {
  statusCode?: number;
  message?: string | string[];
}

function isApiError(v: unknown): v is ApiErrorLike {
  return typeof v === "object" && v !== null && "statusCode" in v;
}

/** Map browser DOMExceptions (NotAllowed, InvalidState, SecurityError) to actionable errors. */
function mapWebAuthnError(err: DOMException, step: "add" | "approve" | "login"): Error {
  if (err.name === "InvalidStateError") {
    return new Error(
      "A PeridotID passkey already exists for this account on this device. To add another, use a different device or a security key, or remove the existing passkey in your browser/OS passkey settings.",
    );
  }
  if (err.name === "NotAllowedError") {
    return new Error(
      step === "add"
        ? "Passkey registration was cancelled or not permitted by this device."
        : step === "login"
          ? "Passkey sign-in was cancelled or not permitted."
          : "Approval with your existing passkey was cancelled or not permitted.",
    );
  }
  if (err.name === "SecurityError") {
    return new Error("WebAuthn is unavailable — try a secure origin (https) or a supported browser.");
  }
  return new Error(err.message || "Passkey operation failed");
}

// WebAuthn options from the API use base64url strings for binary members; the browser
// requires ArrayBuffers. Convert the known members (recursively for credential lists).
function toBuffer(v: unknown): unknown {
  return typeof v === "string" ? toArrayBuffer(b64urlToBytes(v)) : v;
}

function toCreationOptions(options: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const out: Record<string, unknown> = { ...options };
  out.challenge = toBuffer(out.challenge);
  if (out.user && typeof out.user === "object") {
    const user = { ...(out.user as Record<string, unknown>), id: toBuffer((out.user as Record<string, unknown>).id) };
    out.user = user;
  }
  if (Array.isArray(out.excludeCredentials)) {
    out.excludeCredentials = (out.excludeCredentials as Record<string, unknown>[]).map((c) => ({ ...c, id: toBuffer(c.id) }));
  }
  return out as unknown as PublicKeyCredentialCreationOptions;
}

function toRequestOptions(options: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const out: Record<string, unknown> = { ...options };
  out.challenge = toBuffer(out.challenge);
  if (Array.isArray(out.allowCredentials)) {
    out.allowCredentials = (out.allowCredentials as Record<string, unknown>[]).map((c) => ({ ...c, id: toBuffer(c.id) }));
  }
  return out as unknown as PublicKeyCredentialRequestOptions;
}

export { b64urlToBytes };