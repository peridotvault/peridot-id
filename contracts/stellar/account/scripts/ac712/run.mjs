// ANT-712 networked operator — AC2.8 passkey EXECUTE + AC3.4 token-deny.
// Testnet-only. Env: RPC_URL, NETWORK_PASSPHRASE, SOURCE_SECRET,
// PILOT, VERIFIER, POLICY, SAC. Steps:
//   node run.mjs keygen
//   node run.mjs add-rule <secp-priv-hex> <65B-pubkey-hex>
//   node run.mjs execute <65B-pubkey-hex> <secp-priv-hex>
//   node run.mjs replay <exec-file.json>
//   node run.mjs deny <secp-priv-hex> <65B-pubkey-hex>
// Evidence JSON on stdout; diagnostics on stderr.
import { readFileSync } from 'node:fs';
import {
  Account,
  Address,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import {
  authDigestHex,
  authDigestPreimageScVal,
  authEntryV1,
  authPayloadScVal,
  craftAssertion,
  delegatedSignerScVal,
  externalSignerScVal,
  policyInstallParamsScVal,
  signaturePayloadHex,
  verifyAssertionLocal,
  webauthnSigDataXdr,
} from './lib.mjs';

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const PASSPHRASE = process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
const PILOT = process.env.PILOT;
const VERIFIER = process.env.VERIFIER;
const POLICY = process.env.POLICY;
const SAC = process.env.SAC;
const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });

const log = (...a) => console.error('[ac712]', ...a);
const randNonce = () =>
  (BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`) - (1n << 63n)).toString();

function sourceKeypair() {
  const secret = process.env.SOURCE_SECRET;
  if (!secret) throw new Error('SOURCE_SECRET env required (test key only, never mainnet)');
  return Keypair.fromSecret(secret);
}

async function buildOpTx(op, fee = '10000') {
  const kp = sourceKeypair();
  const acc = await server.getAccount(kp.publicKey());
  const source = new Account(kp.publicKey(), acc.sequenceNumber());
  return new TransactionBuilder(source, { fee, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(300)
    .build();
}

function invokeOp({ contractStr, fnName, argsScVals, authEntries }) {
  // NOTE: auth MUST be passed at construction — post-hoc assignment to
  // tx.operations[0].auth does not serialize (verified by XDR roundtrip).
  return Operation.invokeContractFunction({
    contract: contractStr,
    function: fnName,
    args: argsScVals,
    ...(authEntries !== undefined ? { auth: authEntries } : {}),
  });
}

async function enforceAndSubmit({ tx, label, submitOnEnforceFail = false, fallbackSim = null, footprintB64Override = null }) {
  let enforce;
  try {
    // useUpgradedAuth=false: keep our V1 address credentials verbatim (the
    // OZ-test shape).
    enforce = await server.simulateTransaction(tx, undefined, 'enforce', false);
  } catch (e) {
    log(`${label}: enforce-sim TRANSPORT-FAIL ${String(e).slice(0, 400)}`);
    return { enforceOk: false, detail: String(e).slice(0, 1000) };
  }
  const ok = rpc.Api.isSimulationSuccess(enforce);
  let assemblySim = enforce;
  if (!ok) {
    const detail = JSON.stringify(enforce);
    try {
      const fs = await import('node:fs');
      const path = (process.env.SCRATCH || '/tmp') + `/ac712-enforce-${label}-${Date.now()}.json`;
      fs.writeFileSync(path, detail);
      log(`${label}: full enforce response saved to ${path}`);
    } catch {}
    log(`${label}: enforce-sim FAIL ${detail.slice(0, 600)}`);
    if (!submitOnEnforceFail || !fallbackSim) return { enforceOk: false, detail: detail.slice(0, 2000) };
    log(`${label}: submitting failing tx for negative-evidence hash (padded probe footprint)`);
    // The footprint to submit with: an override (a passing call's enforce
    // footprint through the same rule — complete auth read set), else the
    // padded probe footprint. Record-mode footprints emulate (skip) auth
    // crypto, so their instruction budget is too small for the real deny
    // path — pad instructions (and the fee) so the chain reaches the actual
    // policy/verifier logic instead of dying with resource_limit_exceeded.
    const baseData = footprintB64Override
      ? SorobanDataBuilder.fromXdr(footprintB64Override)
      : fallbackSim.transactionData.build();
    log(`${label}: footprint source=${footprintB64Override ? 'override' : 'probe'}`);
    const sdb = new SorobanDataBuilder(baseData);
    const cur = sdb.build();
    const padded = new SorobanDataBuilder(baseData)
      .setResources(
        Math.max(Number(cur.resources.instructions) * 4, 20000000),
        Number(cur.resources.diskReadBytes) * 2 + 10000,
        Number(cur.resources.writeBytes) * 2 + 10000,
      )
      .setResourceFee(cur.resourceFee * 4n + 100000n)
      .build();
    const rebuilt = TransactionBuilder.cloneFrom(tx, {
      networkPassphrase: PASSPHRASE,
      fee: (padded.resourceFee + 100000n).toString(),
      sorobanData: padded,
    }).build();
    try {
      const fp = rebuilt.sorobanData.resources.footprint;
      const ros = fp.readOnly.length + fp.readWrite.length;
      log(`${label}: rebuilt footprint entries=${ros} instructions=${padded.resources.instructions} fee=${padded.resourceFee}`);
    } catch (e) {
      log(`${label}: footprint introspection failed: ${String(e).slice(0, 120)}`);
    }
    rebuilt.sign(sourceKeypair());
    const sent = await server.sendTransaction(rebuilt);
    log(`${label}: send status=${sent.status} hash=${sent.hash}`);
    let status = sent.status;
    let txDetail = null;
    if (sent.status !== 'ERROR') {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const got = await server.getTransaction(sent.hash);
        if (got.status !== 'NOT_FOUND') {
          status = got.status;
          txDetail = got;
          break;
        }
      }
    }
    log(`${label}: final status=${status}`);
    return { enforceOk: false, hash: sent.hash, status, txDetail, detail: detail.slice(0, 2000), footprintB64: new SorobanDataBuilder(baseData).build().toXDR('base64') };
  }
  log(`${label}: enforce-sim PASS`);
  const assembled = rpc.assembleTransaction(tx, enforce).build();
  assembled.sign(sourceKeypair());
  const sent = await server.sendTransaction(assembled);
  log(`${label}: send status=${sent.status} hash=${sent.hash}`);
  let status = sent.status;
  let txDetail = null;
  if (sent.status !== 'ERROR') {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const got = await server.getTransaction(sent.hash);
      if (got.status !== 'NOT_FOUND') {
        status = got.status;
        txDetail = got;
        break;
      }
    }
  }
  log(`${label}: final status=${status}`);
  let fpB64 = null;
  try {
    fpB64 = enforce.transactionData.build().toXDR('base64');
    log(`${label}: footprintB64 len=${fpB64.length}`);
  } catch (e) {
    log(`${label}: footprintB64 extraction failed: ${String(e).slice(0, 200)}`);
  }
  return { enforceOk: ok, hash: sent.hash, status, txDetail, footprintB64: fpB64 };
}

// Single-entry passkey self-auth for any pilot call: record the invocation,
// craft a fresh assertion over (invocation, nonce, expiration), enforce,
// submit. Returns full evidence including the assertion (for replay).
async function externalAuthedCall({ fnName, argsScVals, privHex, pub65Hex, ruleIds, label, submitOnEnforceFail = false, footprintB64Override = null }) {
  const probe = await buildOpTx(invokeOp({ contractStr: PILOT, fnName, argsScVals }));
  const sim = await server.simulateTransaction(probe);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`record-sim failed: ${JSON.stringify(sim).slice(0, 500)}`);
  const invocation = sim.result.auth[0].rootInvocation;
  const expiration = Number(sim.latestLedger) + 200;
  const nonce = randNonce();
  const sigPayloadHex = signaturePayloadHex({ networkPassphrase: PASSPHRASE, nonce, expirationLedger: expiration, invocation });
  const digestHex = authDigestHex({ accountStr: PILOT, signaturePayloadHex: sigPayloadHex, ruleIds });
  const a = craftAssertion({ digestHex, privateKeyHex: privHex, rpId: 'vault.peridot.example', origin: 'https://vault.peridot.example' });
  if (a.publicKey65.toString('hex') !== pub65Hex.toLowerCase()) throw new Error('pubkey mismatch (refusing to spend fees)');
  if (!verifyAssertionLocal(a)) throw new Error('local assertion self-check failed (refusing to spend fees)');
  const sigData = webauthnSigDataXdr({ authenticatorData: a.authData, clientData: a.clientData, signature: a.signature });
  const payload = authPayloadScVal({
    signerEntries: [[externalSignerScVal({ verifierStr: VERIFIER, keyDataBytes: a.publicKey65 }), sigData]],
    ruleIds,
  });
  const entry = authEntryV1({ accountStr: PILOT, nonce, expirationLedger: expiration, signatureScVal: payload, invocation });
  const tx = await buildOpTx(invokeOp({ contractStr: PILOT, fnName, argsScVals, authEntries: [entry] }));
  const res = await enforceAndSubmit({ tx, label, submitOnEnforceFail, fallbackSim: sim, footprintB64Override });
  if (!res.footprintB64) {
    try {
      const probeData = sim.transactionData.build().toXDR('base64');
      res.footprintB64 = probeData;
    } catch {}
  }
  return {
    ...res,
    digestHex,
    nonce: String(nonce),
    expiration,
    assertion: { challenge: a.challenge, sigHex: a.signature.toString('hex'), authDataHex: a.authData.toString('hex'), clientData: a.clientData.toString() },
    execFile: { digestHex, nonce: String(nonce), expiration, sigHex: a.signature.toString('hex'), authDataHex: a.authData.toString('hex'), clientDataB64: a.clientData.toString('base64'), pub65Hex, fnName, ruleIds },
  };
}

function addRuleArgs(externalSigner) {
  return [
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Default')]),
    nativeToScVal(process.env.RULE_NAME || 'nonfinancial-only', { type: 'string' }),
    xdr.ScVal.scvVoid(), // valid_until: None
    xdr.ScVal.scvVec([externalSigner]),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: new Address(POLICY).toScVal(), val: policyInstallParamsScVal() }),
    ]),
  ];
}

async function stepAddRule(privHex, pub65Hex) {
  const ext = externalSignerScVal({ verifierStr: VERIFIER, keyDataBytes: Buffer.from(pub65Hex, 'hex') });
  return await externalAuthedCall({
    fnName: 'add_context_rule',
    argsScVals: addRuleArgs(ext),
    privHex,
    pub65Hex,
    ruleIds: [0],
    label: 'add-rule',
  });
}

function executeArgs() {
  // Target MUST be a different contract: the host forbids a contract
  // re-entering itself, so execute(self, ...) traps with
  // Context/InvalidAction before auth is even evaluated. The Phase-0
  // verifier's read-only canonicalize_key is the ideal target: pure,
  // deterministic, and its return value is checkable on-chain.
  const pub = Buffer.from(process.env.PUB65_HEX, 'hex');
  return [new Address(VERIFIER).toScVal(), xdr.ScVal.scvSymbol('canonicalize_key'), xdr.ScVal.scvVec([xdr.ScVal.scvBytes(pub)])];
}

async function stepExecute(pub65Hex, privHex) {
  return await externalAuthedCall({
    fnName: 'execute',
    argsScVals: executeArgs(),
    privHex,
    pub65Hex,
    ruleIds: [0],
    label: 'execute-passkey',
  });
}

async function stepReplay(execFilePath, privHex) {
  const exec = JSON.parse(readFileSync(execFilePath, 'utf8'));
  const { sigHex, authDataHex, clientDataB64, pub65Hex } = exec.execFile ?? exec;
  // 1. Fresh passing execute through rule 0: yields a complete auth-read
  //    footprint (record-mode footprints skip __check_auth reads).
  const baseline = await externalAuthedCall({
    fnName: 'execute',
    argsScVals: executeArgs(),
    privHex,
    pub65Hex,
    ruleIds: [0],
    label: 'replay-baseline',
  });
  if (!baseline.enforceOk) throw new Error('replay baseline unexpectedly failed');
  const sigData = webauthnSigDataXdr({
    authenticatorData: Buffer.from(authDataHex, 'hex'),
    clientData: Buffer.from(clientDataB64, 'base64'),
    signature: Buffer.from(sigHex, 'hex'),
  });
  // Same invocation shape, FRESH envelope (new nonce+expiration), REUSED assertion bytes.
  const probe = await buildOpTx(invokeOp({ contractStr: PILOT, fnName: 'execute', argsScVals: executeArgs() }));
  const sim = await server.simulateTransaction(probe);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`record-sim failed: ${JSON.stringify(sim).slice(0, 500)}`);
  const invocation = sim.result.auth[0].rootInvocation;
  const expiration = Number(sim.latestLedger) + 200;
  const nonce = randNonce();
  const payload = authPayloadScVal({
    signerEntries: [[externalSignerScVal({ verifierStr: VERIFIER, keyDataBytes: Buffer.from(pub65Hex, 'hex') }), sigData]],
    ruleIds: [0],
  });
  const entry = authEntryV1({ accountStr: PILOT, nonce, expirationLedger: expiration, signatureScVal: payload, invocation });
  const tx = await buildOpTx(invokeOp({ contractStr: PILOT, fnName: 'execute', argsScVals: executeArgs(), authEntries: [entry] }));
  const res = await enforceAndSubmit({ tx, label: 'replay', submitOnEnforceFail: true, fallbackSim: sim, footprintB64Override: baseline.footprintB64 });
  return { ...res, replayedSigHex: sigHex.slice(0, 16), nonce: String(nonce), expiration };
}

async function stepDeny(privHex, pub65Hex) {
  const ruleId = Number(process.env.RULE_ID || '1');
  // 1. Passing nonfinancial dispatch through the SAME rule first: proves the
  //    rule authorizes (External signer valid, policy passes for nonfinancial
  //    targets) and yields a complete auth-read footprint for step 2.
  const dec = await externalAuthedCall({
    fnName: 'execute',
    argsScVals: [new Address(SAC).toScVal(), xdr.ScVal.scvSymbol('decimals'), xdr.ScVal.scvVec([])],
    privHex,
    pub65Hex,
    ruleIds: [ruleId],
    label: 'deny-probe-decimals',
  });
  if (!dec.enforceOk) throw new Error('decimals probe unexpectedly failed — rule wiring broken');
  // 2. The exact case: transfer dispatch through the same rule. Amount is
  //    immaterial to the deny (policy rejects on fn-name during __check_auth,
  //    before the token executes; zero used because classic payments cannot
  //    fund contract addresses so the pilot holds no XLM).
  const amount = nativeToScVal(0n, { type: 'i128' });
  const transferArgs = [new Address(PILOT).toScVal(), new Address(PILOT).toScVal(), amount];
  const deny = await externalAuthedCall({
    fnName: 'execute',
    argsScVals: [new Address(SAC).toScVal(), xdr.ScVal.scvSymbol('transfer'), xdr.ScVal.scvVec(transferArgs)],
    privHex,
    pub65Hex,
    ruleIds: [ruleId],
    label: 'deny-transfer',
    submitOnEnforceFail: true,
    footprintB64Override: dec.footprintB64,
  });
  return { decimalsProbe: { hash: dec.hash, status: dec.status }, deny };
}

async function stepFundPilot(amountXlm) {
  const kp = sourceKeypair();
  const { Asset, Operation: Op } = await import('@stellar/stellar-sdk');
  const acc = await server.getAccount(kp.publicKey());
  const source = new Account(kp.publicKey(), acc.sequenceNumber());
  const tx = new TransactionBuilder(source, { fee: '1000', networkPassphrase: PASSPHRASE })
    .addOperation(Op.payment({ destination: PILOT, asset: Asset.native(), amount: String(Number(amountXlm)) }))
    .setTimeout(300)
    .build();
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  let status = sent.status;
  for (let i = 0; i < 15 && status !== 'ERROR'; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const got = await server.getTransaction(sent.hash);
    if (got.status !== 'NOT_FOUND') {
      status = got.status;
      break;
    }
  }
  return { hash: sent.hash, status };
}

const out = {};
const step = process.argv[2];
try {
  if (step === 'keygen') {
    const kp = Keypair.random();
    console.log(JSON.stringify({ publicKey: kp.publicKey(), secret: kp.secret() }));
    process.exit(0);
  }
  if (!PILOT || !VERIFIER || !POLICY || !SAC) throw new Error('PILOT/VERIFIER/POLICY/SAC env required');
  if (step === 'add-rule') {
    const [priv, pub] = [process.argv[3], process.argv[4]];
    if (!priv || !pub) throw new Error('usage: add-rule <secp-priv-hex> <65B-pubkey-hex>');
    Object.assign(out, await stepAddRule(priv, pub));
  } else if (step === 'execute') {
    const [pub, priv] = [process.argv[3], process.argv[4]];
    if (!pub || !priv) throw new Error('usage: execute <65B-pubkey-hex> <secp-priv-hex>');
    Object.assign(out, await stepExecute(pub, priv));
  } else if (step === 'replay') {
    if (!process.argv[3] || !process.argv[4]) throw new Error('usage: replay <exec-file.json> <secp-priv-hex>');
    Object.assign(out, await stepReplay(process.argv[3], process.argv[4]));
  } else if (step === 'deny') {
    const [priv, pub] = [process.argv[3], process.argv[4]];
    if (!priv || !pub) throw new Error('usage: deny <secp-priv-hex> <65B-pubkey-hex>');
    Object.assign(out, await stepDeny(priv, pub));
  } else if (step === 'fund-pilot') {
    Object.assign(out, await stepFundPilot(process.argv[3] || '2'));
  } else {
    throw new Error(`unknown step: ${step}`);
  }
  console.log(JSON.stringify(out));
} catch (e) {
  log('FATAL', e.message);
  process.exitCode = 1;
}
