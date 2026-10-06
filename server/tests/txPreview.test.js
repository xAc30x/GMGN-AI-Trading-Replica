import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the real client module (type-only imports are erased), as livePreflight.test.js does.
const source = readFileSync(new URL('../../src/txPreview.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
} });
const { checkedRows, formatAtomic, quotePreview } =
  await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('atomic amounts format exactly with the mint decimals', () => {
  assert.equal(formatAtomic('4128000000', 6), '4,128');
  assert.equal(formatAtomic('1234567', 6), '1.234567');
  assert.equal(formatAtomic('1500', 3), '1.5');
  // Large values keep full precision (no float rounding).
  assert.equal(formatAtomic('123456789012345678901', 9), '123,456,789,012.345678');
  assert.equal(formatAtomic('10', undefined), '10 units');
  assert.equal(formatAtomic(undefined, 6), null);
  assert.equal(formatAtomic('-5', 6), null);
  assert.equal(formatAtomic('1e9', 6), null);
});

test('quote preview lists what is sent, received, the slippage limit and price impact', () => {
  const rows = quotePreview({ amountSol: 0.01, symbol: 'TEST', decimals: 6, slippageBps: 100,
    quote: { ok: true, outAmount: '4128000000', otherAmountThreshold: '4086720000', priceImpactPct: '0.0012' } });
  assert.deepEqual(rows.map(r => [r.label, r.value]), [
    ['You send', '0.01 SOL'],
    ['Estimated receive', '4,128 TEST'],
    ['Minimum receive', '≥ 4,086.72 TEST'],
    ['Slippage limit', '1.00%'],
    ['Price impact', '0.12%'],
  ]);
});

test('quote preview leaves out values the quote did not provide', () => {
  const rows = quotePreview({ amountSol: 0.02, symbol: 'X', decimals: 6, slippageBps: 300, quote: { ok: true } });
  assert.deepEqual(rows.map(r => r.label), ['You send', 'Slippage limit']);
});

test('checked transaction rows show the checked amounts and list the two fees separately', () => {
  const rows = checkedRows({ inputAmount: '10000000', minimumOutput: '4086720000', slippageBps: 100,
    priorityFeeLamports: '12500', transactionFeeLamports: 5000 }, 'TEST', 6);
  assert.deepEqual(rows.map(r => [r.label, r.value]), [
    ['You send', '0.01 SOL'],
    ['Minimum receive', '≥ 4,086.72 TEST'],
    ['Slippage limit', '1.00%'],
    ['Network fee (RPC estimate)', '0.000005 SOL'],
    ['Priority fee (in transaction)', '0.0000125 SOL'],
  ]);
});

test('checked transaction rows skip values that are missing or malformed instead of inventing them', () => {
  const rows = checkedRows({ inputAmount: '', minimumOutput: 'x', slippageBps: 50,
    priorityFeeLamports: '0', transactionFeeLamports: Number.NaN }, 'TEST', 6);
  assert.deepEqual(rows.map(r => [r.label, r.value]), [
    ['Slippage limit', '0.50%'],
    ['Priority fee (in transaction)', '0 SOL'],
  ]);
});
