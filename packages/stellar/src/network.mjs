// F1 network pre-check — parity with contracts/stellar/src/auth.rs (ANT-703).
//
// The contract recomputes `network_id` from `env.ledger().network_id()`
// (host truth, SHA-256 of the network passphrase) and rejects mismatches
// with `BadNetwork`. The SDK MUST pre-check before signing: read the
// passphrase from RPC `getNetwork`, derive the expected id, and refuse to
// sign on mismatch — so a testnet intent can never be photo-sent to mainnet.
import { createHash } from 'node:crypto';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

export class BadNetwork extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadNetwork';
    this.code = 'BAD_NETWORK';
  }
}

/** SHA-256 hex of the network passphrase = `env.ledger().network_id()`. */
export function networkId(passphrase) {
  return createHash('sha256').update(passphrase, 'utf8').digest('hex');
}

/**
 * Client pre-check: the passphrase reported by RPC `getNetwork` must equal
 * the passphrase of the network we intend to sign for. Throws {@link BadNetwork}
 * (refuse to sign) on mismatch.
 *
 * @param {string} rpcPassphrase passphrase returned by RPC getNetwork
 * @param {string} expectedPassphrase passphrase of the intended network
 * @returns {string} the matching network id hex (convenience for the sign flow)
 */
export function precheckNetwork(rpcPassphrase, expectedPassphrase) {
  const actual = networkId(rpcPassphrase);
  const expected = networkId(expectedPassphrase);
  if (actual !== expected) {
    throw new BadNetwork(
      `network mismatch (refusing to sign): RPC network id ${actual.slice(0, 16)}… != expected ${expected.slice(0, 16)}…`,
    );
  }
  return expected;
}
