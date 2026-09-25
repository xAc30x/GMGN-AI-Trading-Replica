import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessMint, assertMintSafe } from '../mintSafety.js';

describe('assessMint format', () => {
  it('rejects garbage mint', async () => {
    const a = await assessMint('not-a-mint');
    assert.equal(a.ok, false);
    assert.ok(a.blockers.length > 0);
    assert.throws(() => assertMintSafe(a));
  });
});
