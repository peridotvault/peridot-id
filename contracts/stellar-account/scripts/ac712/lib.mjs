// ANT-712 operator library — pure XDR builders + WebAuthn assertion crafting.
// Testnet-only. No network calls here (see run.mjs); everything is
// deterministic and unit-tested in test/*.test.mjs.
//
// Canonical-encoding rule: every Soroban struct map is built with the SDK's
// `scvSortedMap` (SDK-native ScVal ordering), so key order can never drift
// from what the host accepts. The on-chain gate for encoder correctness is
// the G1 comparison (on-chain `auth_digest` vs local sha256) in run.mjs —
/// unit goldens pin determinism, the chain pins truth.
import { createHash } from 'node:crypto';
import { Address, hash, nativeToScVal, scvSortedMap, xdr } from '@stellar/stellar-sdk';
import { p256 } from '@noble/curves/p256';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Bytes(bytes) {
  return Buffer.from(createHash('sha256').update(bytes).digest());
}

/** base64url (no padding) of raw bytes — the WebAuthn challenge encoding. */
export function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/** XDR bytes of any ScVal. */
export function scValXdr(scVal) {
  return Buffer.from(scVal.toXDR());
}

/** sha256 hex of a ScVal's XDR — the digest family (`auth_digest`, D). */
export function scValDigestHex(scVal) {
  return sha256Hex(scValXdr(scVal));
}

function sortedMap(pairs) {
  return scvSortedMap(pairs.map(([key, val]) => new xdr.ScMapEntry({ key, val })));
}

/**
 * AuthDigestPreimage ScVal: {account, signature_payload, context_rule_ids}.
 * Mirrors OZ 0.8.0 `AuthDigestPreimage` (contracttype struct → sorted str map).
 */
function symKey(name) {
  return xdr.ScVal.scvSymbol(name);
}

export function authDigestPreimageScVal({ accountStr, signaturePayloadHex, ruleIds }) {
  return sortedMap([
    [symKey('account'), new Address(accountStr).toScVal()],
    [symKey('signature_payload'), xdr.ScVal.scvBytes(Buffer.from(signaturePayloadHex, 'hex'))],
    [
      symKey('context_rule_ids'),
      xdr.ScVal.scvVec(ruleIds.map((id) => nativeToScVal(id, { type: 'u32' }))),
    ],
  ]);
}

/** D = sha256(XDR(AuthDigestPreimage)) — what External signers commit to. */
export function authDigestHex({ accountStr, signaturePayloadHex, ruleIds }) {
  return scValDigestHex(authDigestPreimageScVal({ accountStr, signaturePayloadHex, ruleIds }));
}

/**
 * Legacy Soroban signature_payload: sha256 of
 * HashIdPreimageSorobanAuthorization{network_id, nonce, expiration, invocation}.
 * (OZ test reference uses the legacy struct; the host passes this hash to
 * `__check_auth` for V1 address credentials.)
 */
export function signaturePayloadHex({ networkPassphrase, nonce, expirationLedger, invocation }) {
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase, 'utf8')),
      nonce: xdr.Int64.fromString(nonce.toString()),
      signatureExpirationLedger: expirationLedger,
      invocation,
    }),
  );
  return sha256Hex(Buffer.from(preimage.toXDR()));
}

/** Root invocation for `pilot.execute(target, fn, args)` (no sub-invocations). */
export function executeInvocation({ targetStr, fnName, argsScVals }) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(targetStr).toScAddress(),
        functionName: fnName,
        args: argsScVals,
      }),
    ),
    subInvocations: [],
  });
}

/** Signer enum ScVals (contracttype enum → ScVec[Symbol, ...fields]). */
export function externalSignerScVal({ verifierStr, keyDataBytes }) {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('External'),
    new Address(verifierStr).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(keyDataBytes)),
  ]);
}

export function delegatedSignerScVal({ addressStr }) {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Delegated'), new Address(addressStr).toScVal()]);
}

/**
 * Nested G-delegate credential signature: Vec<AccountEd25519Signature>.
 * ANT-716 diagnosis: the host's `check_account_authentication`
 * (soroban-env-host 28.0.2, builtin_contracts/account_contract.rs) parses an
 * Account (G-address) credential signature as a Vec of {public_key,
 * signature} contracttype structs — NOT raw Bytes, NOT Void. Raw Bytes dies
 * with `Value/UnexpectedType` → `Auth/InvalidAction` (reproduced live on
 * testnet); Void (the OZ-test contract-delegate pattern, where the host
 * routes ScAddress::Contract to `__check_auth` without parsing the signature)
 * fails the same way for real G addresses. Proven live: correct shape reaches
 * ed25519 verification ("failed ED25519 verification" instead of
 * UnexpectedType), and the same construction passes in try-runtime (host
 * 28.0.2) with a valid signature.
 *
 * Sign the 32-byte NESTED signature_payload hash (sha256 of the
 * HashIdPreimageSorobanAuthorization XDR over the nested invocation — i.e.
 * the output of `signaturePayloadHex` for the nested nonce/expiration/
 * invocation), never the preimage XDR itself and never the outer payload.
 * Nested nonce/expiration are independent of the outer entry (fresh nonce
 * per entry); entry order is [outer, nested] per the OZ auth_entries tests.
 */
export function delegatedAccountSigVecScVal({ publicKey32, signature64 }) {
  const pubBytes = Buffer.from(publicKey32);
  const sigBytes = Buffer.from(signature64);
  if (pubBytes.length !== 32) throw new Error('publicKey32 must be 32 bytes');
  if (sigBytes.length !== 64) throw new Error('signature64 must be 64 bytes');
  return xdr.ScVal.scvVec([
    sortedMap([
      [symKey('public_key'), xdr.ScVal.scvBytes(pubBytes)],
      [symKey('signature'), xdr.ScVal.scvBytes(sigBytes)],
    ]),
  ]);
}

/**
 * Nested `account.__check_auth(preimage)` invocation for a Delegated(G)
 * self-auth — exactly what OZ 0.8.0 `authenticate()` demands via
 * `addr.require_auth_for_args((preimage,))`. `preimageScVal` is the same
 * `authDigestPreimageScVal` value passed in the outer AuthPayload path
 * (account/signature_payload/context_rule_ids).
 */
export function delegatedNestedInvocation({ accountStr, preimageScVal }) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(accountStr).toScAddress(),
        functionName: '__check_auth',
        args: [preimageScVal],
      }),
    ),
    subInvocations: [],
  });
}

/**
 * AuthPayload ScVal: {signers: Map<Signer,Bytes>, context_rule_ids}.
 * signerEntries: [[signerScVal, sigBytesBuffer], ...].
 */
export function authPayloadScVal({ signerEntries, ruleIds }) {
  const signers = sortedMap(
    signerEntries.map(([signerScVal, sigBytes]) => [signerScVal, xdr.ScVal.scvBytes(Buffer.from(sigBytes))]),
  );
  return sortedMap([
    [symKey('context_rule_ids'), xdr.ScVal.scvVec(ruleIds.map((id) => nativeToScVal(id, { type: 'u32' })))],
    [symKey('signers'), signers],
  ]);
}

/** Install params for the nonfinancial-only policy: {version: 1}. */
export function policyInstallParamsScVal() {
  return sortedMap([[symKey('version'), nativeToScVal(1, { type: 'u32' })]]);
}

/** V1 address-credential auth entry (the OZ-test shape the host accepts). */
export function authEntryV1({ accountStr, nonce, expirationLedger, signatureScVal, invocation }) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(accountStr).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: expirationLedger,
        signature: signatureScVal,
      }),
    ),
    rootInvocation: invocation,
  });
}

/**
 * WebAuthnSigData XDR bytes (opaque sig_data for the Phase-0 verifier):
 * ScMap{authenticator_data, client_data, signature} — the verifier contract
 * XDR-decodes this exact shape internally.
 */
export function webauthnSigDataXdr({ authenticatorData, clientData, signature }) {
  return scValXdr(
    sortedMap([
      [symKey('authenticator_data'), xdr.ScVal.scvBytes(Buffer.from(authenticatorData))],
      [symKey('client_data'), xdr.ScVal.scvBytes(Buffer.from(clientData))],
      [symKey('signature'), xdr.ScVal.scvBytes(Buffer.from(signature))],
    ]),
  );
}

/** Fixed 37B authenticator_data: rpIdHash(32) ‖ flags(1) ‖ signCount(4BE=0). */
export function authenticatorData({ rpId, flags }) {
  const rpIdHash = sha256Bytes(Buffer.from(rpId, 'utf8'));
  const out = Buffer.alloc(37);
  rpIdHash.copy(out, 0);
  out[32] = flags;
  out.writeUInt32BE(0, 33);
  return out;
}

export function clientDataJson({ challengeB64url, origin }) {
  return Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge: challengeB64url, origin, crossOrigin: false }),
    'utf8',
  );
}

/**
 * Craft a WebAuthn assertion binding digest D (challenge = base64url(D)).
 * Signs M = sha256(authData ‖ sha256(clientData)) with raw ES256-prehash
 * (noble `sign` over the 32B hash directly — matching Soroban's
 * `secp256r1_verify`, like OZ's `sign_prehash` test vector), low-S normalized.
 */
export function craftAssertion({ digestHex, privateKeyHex, rpId, origin, flags = 0x05 }) {
  const challenge = b64url(Buffer.from(digestHex, 'hex'));
  const authData = authenticatorData({ rpId, flags });
  const clientData = clientDataJson({ challengeB64url: challenge, origin });
  const messageHash = sha256Bytes(Buffer.concat([authData, sha256Bytes(clientData)]));
  const priv = Buffer.from(privateKeyHex, 'hex');
  const sig = p256.sign(messageHash, priv);
  const signature = Buffer.from(sig.normalizeS().toCompactRawBytes());
  const pubUncompressed = Buffer.from(p256.getPublicKey(priv, false));
  return { challenge, authData, clientData, signature, publicKey65: pubUncompressed };
}

/** Verify an assertion off-chain (noble) — sanity before spending fees. */
export function verifyAssertionLocal({ authData, clientData, signature, publicKey65 }) {
  const messageHash = sha256Bytes(Buffer.concat([authData, sha256Bytes(clientData)]));
  return p256.verify(Buffer.from(signature), messageHash, Buffer.from(publicKey65));
}
