import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  solToLamports,
  clampSlippageBps,
  assertPriceImpactOk,
  MAX_SLIPPAGE_BPS,
  DEFAULT_SLIPPAGE_BPS,
} from '../jupiterSol.js';

describe('solToLamports', () => {
  it('converts whole SOL', () => {
    assert.equal(solToLamports('1'), 1_000_000_000n);
  });
  it('converts fractional without float drift', () => {
    assert.equal(solToLamports('0.05'), 50_000_000n);
    assert.equal(solToLamports('0.01'), 10_000_000n);
  });
  it('rejects junk', () => {
    assert.throws(() => solToLamports('abc'), /Invalid SOL amount/);
  });
});

describe('clampSlippageBps', () => {
  it('defaults', () => {
    assert.equal(clampSlippageBps(undefined), DEFAULT_SLIPPAGE_BPS);
  });
  it('allows within max', () => {
    assert.equal(clampSlippageBps(250), 250);
  });
  it('rejects over max', () => {
    assert.throws(() => clampSlippageBps(MAX_SLIPPAGE_BPS + 1), /exceeds max/);
  });
});

describe('assertPriceImpactOk', () => {
  it('allows small fraction impact', () => {
    assert.doesNotThrow(() => assertPriceImpactOk({ priceImpactPct: '0.01' })); // 1%
  });
  it('blocks high percent impact', () => {
    assert.throws(() => assertPriceImpactOk({ priceImpactPct: '12' }), /Price impact/);
  });
});
