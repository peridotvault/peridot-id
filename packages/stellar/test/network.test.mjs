// F1 network pre-check tests (ANT-703). Network-id vectors are pinned by
// the Rust side (auth.rs cross-network test recomputes them from the same
// passphrases via SHA-256).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TESTNET_PASSPHRASE,
  MAINNET_PASSPHRASE,
  BadNetwork,
  networkId,
  precheckNetwork,
} from '../src/network.mjs';

describe('network ids', () => {
  it('testnet id matches host truth', () => {
    assert.equal(networkId(TESTNET_PASSPHRASE), 'cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472');
  });
  it('mainnet id matches host truth and differs from testnet', () => {
    assert.equal(networkId(MAINNET_PASSPHRASE), '7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979');
    assert.notEqual(networkId(TESTNET_PASSPHRASE), networkId(MAINNET_PASSPHRASE));
  });
});

describe('precheckNetwork (refuse-to-sign gate)', () => {
  it('passes when RPC network is the intended network', () => {
    assert.equal(precheckNetwork(TESTNET_PASSPHRASE, TESTNET_PASSPHRASE), networkId(TESTNET_PASSPHRASE));
  });
  it('throws BadNetwork on cross-network mismatch', () => {
    assert.throws(() => precheckNetwork(MAINNET_PASSPHRASE, TESTNET_PASSPHRASE), BadNetwork);
    assert.throws(() => precheckNetwork(TESTNET_PASSPHRASE, MAINNET_PASSPHRASE), BadNetwork);
  });
});
