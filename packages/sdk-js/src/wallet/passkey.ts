// Browser WebAuthn passkey integration (task 009). Provides the PasskeySigner the Solana
// adapter needs, plus the registration ceremony client for the credentials API (task 003).

import { b64url, b64urlToBytes, derToRawEcdsa } from "@peridot/solana";
import type { PasskeyAssertion, PasskeySigner } from "@peridot/solana";
import type {
  Authority,
  RegisterStart,
} from "@peridot/types";

function bytesOf(v: ArrayBuffer | ArrayBufferView): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.slice().buffer as ArrayBuffer;
}

function credResponseToJson(c: PublicKeyCredential): {
  id: string;
  rawId: string;
  response: { clientDataJSON: string; attestationObject: string };
} {
  const r = c.response as AuthenticatorAttestationResponse;
  return {
    id: c.id,
    rawId: b64url(bytesOf(c.rawId)),
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
      throw new Error("WebAuthn tidak tersedia di perangkat ini");
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
    if (!cred) throw new Error("Autentikasi passkey dibatalkan");

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
  const publicKey = start.options as unknown as PublicKeyCredentialCreationOptions;
  credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential;
  if (!credential) throw new Error("Registrasi passkey dibatalkan");

  if (start.isAdditional && start.approval) {
    approval = await navigator.credentials.get({
      publicKey: start.approval as unknown as PublicKeyCredentialRequestOptions,
    });
  }

  const finish = await api.registerFinish({
    registrationId: start.registrationId,
    credential: credResponseToJson(credential),
    approval: approval ? toAssertionJson(approval as PublicKeyCredential) : undefined,
  });
  if (isApiError(finish)) throw new Error((finish as { message: string }).message);
  return finish as Authority;
}

function toAssertionJson(a: PublicKeyCredential): {
  id: string;
  rawId: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string };
} {
  const r = a.response as AuthenticatorAssertionResponse;
  return {
    id: a.id,
    rawId: b64url(bytesOf(a.rawId)),
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

export { b64urlToBytes };