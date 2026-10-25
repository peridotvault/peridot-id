// ANT-556: fee-policy v2 vectors (ANT-544 B3, byte/unit-exact) + V4 payload pins.
// Runs against the BUILT package (pretest builds): the shipped artifact.
// Run: `node --test test/` from packages/core.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitAttestedFeeV2,
  solanaFeeV2Row,
  CHAIN_MIN_LAMPORTS_V2,
  buildAuthorizationPayloadV4,
  DOMAIN_V4,
  IX_V4,
  OP_V4,
} from "../dist/index.js";
import {
  splitEvmFeeV2,
  evmChainMinV2,
  EVM_PROTOCOL_FEE_BPS_V2,
  buildEvmAuthorizationPayloadV4,
  DOMAIN_EVM_V4,
  DOMAIN_EVM_PERM_V2,
  DOMAIN_EVM_PERM_V1,
  PERM_KIND,
  assertNonfinancialKind,
  buildGrantPayload,
  buildPermExecPayload,
} from "../dist/evm.js";

describe("solana fee v2 (ANT-544 B3)", () => {
  it("B3 vector: network 5000 lamports → floor 17000 wins → total 22000", () => {
    const { bps, chainMin } = solanaFeeV2Row();
    assert.equal(bps, 5000);
    assert.equal(chainMin, 17_000n);
    assert.equal(CHAIN_MIN_LAMPORTS_V2, 17_000n);
    const { relayerFee, protocolFee, totalFee } = splitAttestedFeeV2(5_000n, bps, chainMin);
    assert.equal(relayerFee, 5_000n);
    assert.equal(protocolFee, 17_000n);
    assert.equal(totalFee, 22_000n);
  });

  it("percentage leg wins above the floor; exact boundary passes", () => {
    const { bps, chainMin } = solanaFeeV2Row();
    assert.deepEqual(splitAttestedFeeV2(100_000n, bps, chainMin), {
      relayerFee: 100_000n, protocolFee: 50_000n, totalFee: 150_000n,
    });
    // 34_000 → 17_000 == floor exactly.
    assert.equal(splitAttestedFeeV2(34_000n, bps, chainMin).protocolFee, 17_000n);
  });

  it("V4 domain/op-tags are pinned and disjoint from V3", async () => {
    assert.deepEqual([...DOMAIN_V4].join(","), [...Buffer.from("PID|SOLANA|SMART_ACCOUNT|v4", "ascii")].join(","));
    assert.deepEqual(IX_V4, { withdrawSol: 11, withdrawToken: 12, execute: 13, activate: 14 });
    assert.deepEqual(OP_V4, { withdrawSol: 11, withdrawToken: 12, execute: 13, activate: 14 });
    const a = await buildAuthorizationPayloadV4(13, [new Uint8Array([1, 2, 3])]);
    const b = await buildAuthorizationPayloadV4(13, [new Uint8Array([1, 2, 4])]);
    assert.notDeepEqual(a, b);
  });
});

describe("evm fee v2 (ANT-544 B2/B3)", () => {
  it("chain rows are exact (750 gwei eth/base, 2.3e12 bsc, 0 unlisted)", () => {
    assert.equal(EVM_PROTOCOL_FEE_BPS_V2, 5000);
    for (const cid of [1, 11155111, 8453, 84532, 31337]) assert.equal(evmChainMinV2(cid), 750_000_000_000n);
    for (const cid of [56, 97]) assert.equal(evmChainMinV2(cid), 2_300_000_000_000n);
    assert.equal(evmChainMinV2(10), 0n);
  });

  it("B3: ethereum 0.000021 ETH → 50% wins → total 0.0000315 ETH", () => {
    const net = 21_000_000_000_000n;
    const { protocolFee, totalFee } = splitEvmFeeV2(net, 1);
    assert.equal(protocolFee, 10_500_000_000_000n);
    assert.equal(totalFee, 31_500_000_000_000n);
  });

  it("B3: base 0.0000002 ETH → floor wins → total 0.00000095 ETH", () => {
    const net = 200_000_000_000n;
    const { protocolFee, totalFee } = splitEvmFeeV2(net, 8453);
    assert.equal(protocolFee, 750_000_000_000n);
    assert.equal(totalFee, 950_000_000_000n);
  });

  it("B3: bsc 0.0000021 BNB → floor wins → total 0.0000044 BNB", () => {
    const net = 2_100_000_000_000n;
    const { protocolFee, totalFee } = splitEvmFeeV2(net, 56);
    assert.equal(protocolFee, 2_300_000_000_000n);
    assert.equal(totalFee, 4_400_000_000_000n);
  });

  it("PERM v2 domain differs from v1; kinds are non-financial-only", () => {
    assert.notDeepEqual(DOMAIN_EVM_PERM_V2, DOMAIN_EVM_PERM_V1);
    assert.deepEqual(PERM_KIND, { nonfinancial: 1 });
    assertNonfinancialKind(1);
    for (const k of [0, 2, 3, 4, 5, 6]) assert.throws(() => assertNonfinancialKind(k));
  });

  it("grant payload binds feeLimit and rejects financial kinds", () => {
    const scope = {
      sessionX: new Uint8Array(32).fill(1), sessionY: new Uint8Array(32).fill(2),
      kind: 1, target: "0x000000000000000000000000000000000000beef",
      selector: new Uint8Array([9, 9, 9, 9]),
      token: "0x0000000000000000000000000000000000000000",
      to: "0x0000000000000000000000000000000000000000",
      nftId: 0, validUntil: 999, salt: new Uint8Array(32).fill(3),
    };
    const a = buildGrantPayload({
      chainId: 31337, account: "0x000000000000000000000000000000000000cafe",
      permissionId: new Uint8Array(32).fill(4), scope,
      perTxCap: 0, totalLimit: 0, feeLimit: 1000, validAfter: 1, nonce: 0, deadline: 2,
    });
    const b = buildGrantPayload({
      chainId: 31337, account: "0x000000000000000000000000000000000000cafe",
      permissionId: new Uint8Array(32).fill(4), scope,
      perTxCap: 0, totalLimit: 0, feeLimit: 1001, validAfter: 1, nonce: 0, deadline: 2,
    });
    assert.notDeepEqual(a, b); // feeLimit is bound
    assert.throws(() => buildGrantPayload({
      chainId: 31337, account: "0x000000000000000000000000000000000000cafe",
      permissionId: new Uint8Array(32).fill(4), scope: { ...scope, kind: 2 },
      perTxCap: 0, totalLimit: 0, validAfter: 1, nonce: 0, deadline: 2,
    }), /removed/);
  });

  it("perm-exec payload binds maxTotalFee; V4 owner domain is disjoint", async () => {
    const base = {
      chainId: 31337, account: "0x000000000000000000000000000000000000cafe",
      permissionId: new Uint8Array(32).fill(4), seq: 0,
      target: "0x000000000000000000000000000000000000beef", value: 0,
      dataHash: new Uint8Array(32).fill(5), deadline: 9, feePolicyVersion: 1,
    };
    assert.notDeepEqual(buildPermExecPayload({ ...base, maxTotalFee: 7 }), buildPermExecPayload({ ...base, maxTotalFee: 8 }));
    const v4a = await buildEvmAuthorizationPayloadV4(0x01, [new Uint8Array([1])]);
    const v4b = await buildEvmAuthorizationPayloadV4(0x01, [new Uint8Array([2])]);
    assert.notDeepEqual(v4a, v4b);
    assert.deepEqual([...DOMAIN_EVM_V4].join(","), [...Buffer.from("PID|EVM|SMART_ACCOUNT|v4", "ascii")].join(","));
  });
});
