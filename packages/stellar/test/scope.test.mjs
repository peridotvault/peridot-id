// T3 TS↔Rust parity tests (ANT-703). Golden vectors are pinned by
// contracts/stellar/phase0-experiments/src/rules.rs `golden_scope_hash_vectors` — any layout
// divergence fails here by design.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RULE_CLASS_TAGS, ScopeTooLarge, ScopeInvalid, scopeCanonical, scopeHash } from '../src/scope.mjs';

const C1 = '01'.repeat(32);
const CAA = 'aa'.repeat(32);
const CBB = 'bb'.repeat(32);

describe('scope golden vectors (Rust parity)', () => {
  it('V1 game-move matches Rust', () => {
    assert.equal(
      scopeHash(RULE_CLASS_TAGS.GameMove, [C1], ['make_move', 'forfeit']),
      '3ec34e3d5456b933bd07772925ecd087b628820601c8734c5e628ed2a57a3cca',
    );
  });
  it('V2 state-read any-contract matches Rust', () => {
    assert.equal(
      scopeHash(RULE_CLASS_TAGS.StateRead, [], ['read_state']),
      'fdbb3ec797c7e254cddacd2a9d14c4d4d8eb5ebc9566a75cebca31b899a947d7',
    );
  });
  it('V3 profile-write matches Rust', () => {
    assert.equal(
      scopeHash(RULE_CLASS_TAGS.ProfileWrite, [CAA, CBB], ['set_avatar']),
      '01853f84e337c9ff69a660bcedeb26f003cb7542d3529c1db3e456c5e7c73775',
    );
  });
  it('V1 canonical bytes match Rust layout (len 70)', () => {
    const canon = scopeCanonical(RULE_CLASS_TAGS.GameMove, [C1], ['make_move', 'forfeit']);
    assert.equal(canon.length, 70);
    assert.equal(
      canon.toString('hex'),
      '67616d652d6d6f7665000100000001010101010101010101010101010101010101010101010101010101010101010200000009006d616b655f6d6f76650700666f7266656974',
    );
  });
});

describe('scope binding properties', () => {
  it('closes the (ab,c) vs (a,bc) concatenation ambiguity', () => {
    const h1 = scopeHash(RULE_CLASS_TAGS.GameMove, [C1], ['ab', 'c']);
    const h2 = scopeHash(RULE_CLASS_TAGS.GameMove, [C1], ['a', 'bc']);
    assert.notEqual(h1, h2);
  });
  it('order-sensitive in contracts and fns', () => {
    assert.notEqual(
      scopeHash(RULE_CLASS_TAGS.GameMove, [C1, CAA], ['f', 'g']),
      scopeHash(RULE_CLASS_TAGS.GameMove, [CAA, C1], ['f', 'g']),
    );
    assert.notEqual(
      scopeHash(RULE_CLASS_TAGS.GameMove, [C1], ['f', 'g']),
      scopeHash(RULE_CLASS_TAGS.GameMove, [C1], ['g', 'f']),
    );
  });
  it('any-contract (n=0) distinct from one-contract', () => {
    assert.notEqual(
      scopeHash(RULE_CLASS_TAGS.GameMove, [], ['f']),
      scopeHash(RULE_CLASS_TAGS.GameMove, [C1], ['f']),
    );
  });
  it('rejects oversize descriptors with ScopeTooLarge', () => {
    assert.throws(
      () => scopeCanonical(RULE_CLASS_TAGS.GameMove, [C1], Array.from({ length: 65 }, (_, i) => `fn${i}`)),
      ScopeTooLarge,
    );
    assert.throws(() => scopeCanonical(RULE_CLASS_TAGS.GameMove, [C1], ['x'.repeat(65)]), ScopeTooLarge);
    assert.throws(
      () => scopeCanonical(RULE_CLASS_TAGS.GameMove, Array.from({ length: 65 }, () => C1), ['f']),
      ScopeTooLarge,
    );
  });
  it('rejects programmer errors with ScopeInvalid (finding 4, ANT-704)', () => {
    assert.throws(() => scopeCanonical('financial', [C1], ['f']), ScopeInvalid);
    assert.throws(() => scopeCanonical('game-moveX', [C1], ['f']), ScopeInvalid);
    assert.throws(() => scopeCanonical(RULE_CLASS_TAGS.GameMove, ['zz'], ['f']), ScopeInvalid);
    assert.throws(() => scopeCanonical(RULE_CLASS_TAGS.GameMove, ['01'.repeat(31)], ['f']), ScopeInvalid);
  });
});
