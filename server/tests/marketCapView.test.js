import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/format.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
const { marketCapView, MARKET_CAP_FRESH_MS } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const now = 1_000_000;

test('a higher market cap than at buy shows the rise in green', () => {
  assert.deepEqual(marketCapView(120000, { usd: 135000, at: now - 5000 }, now),
    { text: 'MC $120.0K → $135.0K (+12.5%)', tone: 'pos' });
});

test('a lower market cap than at buy shows the drop in red', () => {
  assert.deepEqual(marketCapView(2_000_000, { usd: 1_500_000, at: now }, now),
    { text: 'MC $2.0M → $1.5M (-25.0%)', tone: 'neg' });
});

test('an out-of-date latest market cap is shown as unknown', () => {
  assert.deepEqual(marketCapView(120000, { usd: 135000, at: now - MARKET_CAP_FRESH_MS - 1 }, now),
    { text: 'MC at buy $120.0K · now unknown', tone: null });
  assert.deepEqual(marketCapView(120000, null, now), { text: 'MC at buy $120.0K · now unknown', tone: null });
});

test('positions opened before market caps were saved show only the current one', () => {
  assert.deepEqual(marketCapView(undefined, { usd: 135000, at: now }, now), { text: 'MC now $135.0K', tone: null });
});

test('nothing is shown when neither market cap is known or values are invalid', () => {
  assert.equal(marketCapView(null, null, now), null);
  assert.equal(marketCapView(0, { usd: Number.NaN, at: now }, now), null);
});
