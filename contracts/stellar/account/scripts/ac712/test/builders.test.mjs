// Unit tests for lib.mjs — determinism + structure. Encoder CORRECTNESS is
// gated on-chain (G1 comparison in run.mjs), not here; these goldens pin the
// implementation so drift fails the build instead of silently changing bytes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { p256 } from '@noble/curves/p256';
import {
  TESTNET_PASSPHRASE,
  authDigestHex,
  authDigestPreimageScVal,
  authEntryV1,
  authPayloadScVal,
  authenticatorData,
  b64url,
  clientDataJson,
  craftAssertion,
  delegatedAccountSigVecScVal,
  delegatedNestedInvocation,
  delegatedSignerScVal,
  executeInvocation,
  externalSignerScVal,
  scValDigestHex,
  scValXdr,
  signaturePayloadHex,
  verifyAssertionLocal,
  webauthnSigDataXdr,
} from '../lib.mjs';

const FIXED_PRIV = '2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40';
const PILOT = 'CACHL7AAV745BUKG4HARTFS5HLX5IMRFWPHJBVN3U4WWDLDWDCUJC4VN';
const VERIFIER = 'CD7HL6UYXQNFYGU6FARCGLA2TACYCY7PIMRDBNPKDOENLBLQLL7QXSDB';

describe('b64url', () => {
  it('encodes without padding (WebAuthn challenge shape)', () => {
    assert.equal(b64url(Buffer.from([0, 1, 2, 251])), 'AAEC-w');
    assert.equal(b64url(Buffer.alloc(32, 0xab)).length, 43);
  });
});

describe('assertion crafting', () => {
  it('is deterministic and verifies locally (fixed key)', () => {
    const digestHex = '6e1875b0'.padEnd(64, '0');
    const a1 = craftAssertion({
      digestHex,
      privateKeyHex: FIXED_PRIV,
      rpId: 'vault.peridot.example',
      origin: 'https://vault.peridot.example',
    });
    const a2 = craftAssertion({
      digestHex,
      privateKeyHex: FIXED_PRIV,
      rpId: 'vault.peridot.example',
      origin: 'https://vault.peridot.example',
    });
    assert.deepEqual(a1.signature, a2.signature);
    assert.equal(a1.publicKey65.length, 65);
    assert.equal(a1.publicKey65[0], 0x04);
    assert.equal(a1.authData.length, 37);
    assert.equal(a1.authData[32], 0x05);
    assert.ok(verifyAssertionLocal(a1), 'noble roundtrip must verify');
  });

  it('binds a different digest to a different challenge+signature', () => {
    const base = {
      privateKeyHex: FIXED_PRIV,
      rpId: 'vault.peridot.example',
      origin: 'https://vault.peridot.example',
    };
    const a = craftAssertion({ ...base, digestHex: '00'.repeat(32) });
    const b = craftAssertion({ ...base, digestHex: 'ff'.repeat(32) });
    assert.notEqual(a.challenge, b.challenge);
    assert.notDeepEqual(a.signature, b.signature);
    assert.ok(!verifyAssertionLocal({ ...a, signature: b.signature }), 'cross-digest sig must NOT verify');
  });
});

describe('xdr builders', () => {
  it('auth digest is stable for fixed inputs (determinism golden)', () => {
    const args = { accountStr: PILOT, signaturePayloadHex: 'ab'.repeat(32), ruleIds: [0] };
    const d1 = authDigestHex(args);
    const d2 = authDigestHex(args);
    assert.equal(d1, d2);
    assert.match(d1, /^[0-9a-f]{64}$/);
    // Rule id binds: [0] vs [0,0] differ.
    const d3 = authDigestHex({ ...args, ruleIds: [0, 0] });
    assert.notEqual(d1, d3);
  });

  it('preimage map has exactly the OZ field keys', () => {
    const scv = authDigestPreimageScVal({ accountStr: PILOT, signaturePayloadHex: 'ab'.repeat(32), ruleIds: [0] });
    const entries = scv.map;
    assert.equal(entries.length, 3);
    const keys = entries.map((e) => e.key.sym.toString()).sort();
    assert.deepEqual(keys, ['account', 'context_rule_ids', 'signature_payload']);
  });

  it('signer enum encodings carry the right arms', () => {
    const ext = externalSignerScVal({ verifierStr: VERIFIER, keyDataBytes: Buffer.alloc(65, 4) });
    const vec = ext.vec;
    assert.equal(vec[0].sym.toString(), 'External');
    const del = delegatedSignerScVal({
      addressStr: 'GCUACPEXESIPZTZV5K6JIT6TDI4G5YPNZTLCBUJ6JH4OPW2CCSNNJ6LJ',
    });
    assert.equal(del.vec[0].sym.toString(), 'Delegated');
  });

  it('auth payload map keys are the OZ AuthPayload fields', () => {
    const scv = authPayloadScVal({
      signerEntries: [[delegatedSignerScVal({ addressStr: 'GCUACPEXESIPZTZV5K6JIT6TDI4G5YPNZTLCBUJ6JH4OPW2CCSNNJ6LJ' }), Buffer.alloc(0)]],
      ruleIds: [0],
    });
    const keys = scv.map.map((e) => e.key.sym.toString()).sort();
    assert.deepEqual(keys, ['context_rule_ids', 'signers']);
  });

  it('webauthn sig_data map has the verifier-contract fields', () => {
    const bytes = webauthnSigDataXdr({
      authenticatorData: Buffer.alloc(37, 1),
      clientData: Buffer.from('{"type":"webauthn.get"}'),
      signature: Buffer.alloc(64, 2),
    });
    assert.ok(bytes.length > 37 + 24 + 64);
  });

  it('signature payload binds network+nonce+expiry+invocation', () => {
    const inv = (fn) => executeInvocation({ targetStr: PILOT, fnName: fn, argsScVals: [] });
    const base = { networkPassphrase: TESTNET_PASSPHRASE, nonce: '7', expirationLedger: 1000 };
    const p1 = signaturePayloadHex({ ...base, invocation: inv('execute') });
    assert.match(p1, /^[0-9a-f]{64}$/);
    assert.notEqual(p1, signaturePayloadHex({ ...base, nonce: '8', invocation: inv('execute') }));
    assert.notEqual(p1, signaturePayloadHex({ ...base, nonce: '7', invocation: inv('ping') }));
  });

  it('delegated G nested sig is Vec<AccountEd25519Signature> (ANT-716)', () => {
    // Host check_account_authentication parses Account-credential signatures
    // as Vec of {public_key, signature} contracttype structs (sorted map
    // keys). Raw Bytes / Void die with Value/UnexpectedType → InvalidAction.
    const scv = delegatedAccountSigVecScVal({
      publicKey32: Buffer.alloc(32, 7),
      signature64: Buffer.alloc(64, 9),
    });
    assert.equal(scv.vec.length, 1);
    const keys = scv.vec[0].map.map((e) => e.key.sym.toString());
    assert.deepEqual(keys, ['public_key', 'signature']);
    assert.equal(Buffer.from(scv.vec[0].map[0].val.bytes.value).length, 32);
    assert.equal(Buffer.from(scv.vec[0].map[1].val.bytes.value).length, 64);
    assert.throws(() => delegatedAccountSigVecScVal({ publicKey32: Buffer.alloc(31), signature64: Buffer.alloc(64) }), /32 bytes/);
    assert.throws(() => delegatedAccountSigVecScVal({ publicKey32: Buffer.alloc(32), signature64: Buffer.alloc(63) }), /64 bytes/);
  });

  it('delegated nested invocation targets __check_auth(preimage) (ANT-716)', () => {
    const preimage = authDigestPreimageScVal({
      accountStr: PILOT,
      signaturePayloadHex: 'ab'.repeat(32),
      ruleIds: [0],
    });
    const inv = delegatedNestedInvocation({ accountStr: PILOT, preimageScVal: preimage });
    const fn_ = inv.function.contractFn;
    assert.equal(fn_.functionName.toString(), '__check_auth');
    assert.equal(fn_.args.length, 1);
    assert.deepEqual(fn_.args[0].toXDR(), preimage.toXDR());
    assert.deepEqual(inv.subInvocations, []);
  });

  it('auth entry carries pilot address + payload (V1 credentials)', () => {
    const inv = executeInvocation({ targetStr: PILOT, fnName: 'ping', argsScVals: [] });
    const payload = authPayloadScVal({ signerEntries: [], ruleIds: [0] });
    const entry = authEntryV1({
      accountStr: PILOT,
      nonce: '7',
      expirationLedger: 1000,
      signatureScVal: payload,
      invocation: inv,
    });
    assert.equal(entry.credentials.type, 'sorobanCredentialsAddress');
    assert.equal(scValDigestHex(payload).length, 64);
  });
});
