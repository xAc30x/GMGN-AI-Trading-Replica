import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the real client module (type-only imports are erased), as livePreflight.test.js does.
const source = readFileSync(new URL('../../src/tradeGate.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
} });
const { tradeGate, tradeRails, AMOUNT_PRESETS } =
  await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const ready = {
  mode: 'PAPER', amount: 0.01, maxNative: 0.05, checked: true, checking: false,
  verdict: 'PASS', warningCount: 0, acknowledged: false, held: false, heldKnown: true,
};

test('a passing, unheld token within limits can be traded in PAPER and LIVE', () => {
  assert.deepEqual(tradeGate(ready), { can: true, needsAck: false, label: 'Continue to paper buy · 0.01 SOL' });
  assert.equal(tradeGate({ ...ready, mode: 'LIVE' }).label, 'Hold to send to wallet · 0.01 SOL');
});

test('failed checks, an existing position or missing data block the button', () => {
  const blocked = input => { const g = tradeGate({ ...ready, ...input }); assert.equal(g.can, false); return g.label; };
  assert.equal(blocked({ verdict: 'BLOCKED' }), 'Blocked · failed safety checks');
  assert.equal(blocked({ held: true }), 'Already holding · 1 position per mint');
  assert.equal(blocked({ heldKnown: false }), 'Open positions not loaded');
  assert.equal(blocked({ checked: false, verdict: null }), 'Safety checks not loaded');
  assert.equal(blocked({ checking: true }), 'Checking safety…');
  assert.equal(blocked({ maxNative: null }), 'Server limits not loaded');
  assert.equal(blocked({ amount: 0.06 }), 'Amount is above the 0.05 SOL limit');
  assert.equal(blocked({ amount: 0 }), 'Choose an amount');
  assert.equal(blocked({ mode: 'SHADOW' }), 'Switch to PAPER to trade');
  // A blocked verdict wins even when the warnings were acknowledged.
  assert.equal(blocked({ verdict: 'BLOCKED', acknowledged: true }), 'Blocked · failed safety checks');
});

test('warnings must be acknowledged before trading', () => {
  const review = { ...ready, verdict: 'REVIEW', warningCount: 2 };
  assert.deepEqual(tradeGate(review), { can: false, needsAck: true, label: 'Acknowledge 2 warnings to continue' });
  assert.equal(tradeGate({ ...review, warningCount: 1 }).label, 'Acknowledge the warning to continue');
  assert.equal(tradeGate({ ...review, acknowledged: true }).can, true);
});

test('rails use the server limits; LIVE adds exposure and positions after this trade', () => {
  const base = { mode: 'PAPER', amount: 0.01, maxNative: 0.05, exposureSol: 0.03, openPositions: 2, held: false,
    maxPortfolioSol: 0.1, maxOpenPositions: 5 };
  assert.deepEqual(tradeRails(base), [{ label: 'This trade', value: '0.010 / 0.050', pct: 20, tone: 'ok' }]);
  const live = tradeRails({ ...base, mode: 'LIVE', amount: 0.05 });
  assert.deepEqual(live.map(r => [r.label, r.value, r.tone]), [
    ['This trade', '0.050 / 0.050', 'near'],
    ['Exposure after', '0.080 / 0.100', 'ok'],
    ['Positions after', '3 / 5', 'ok'],
  ]);
  const over = tradeRails({ ...base, mode: 'LIVE', exposureSol: 0.095, openPositions: 5 });
  assert.equal(over[1].tone, 'over');
  assert.equal(over[1].pct, 100);
  assert.equal(over[2].value, '6 / 5');
  assert.deepEqual(tradeRails({ ...base, maxNative: null }), []);
});

test('amount presets stay within the default per-trade limit', () => {
  assert.ok(AMOUNT_PRESETS.every(a => a > 0 && a <= 0.05));
});
