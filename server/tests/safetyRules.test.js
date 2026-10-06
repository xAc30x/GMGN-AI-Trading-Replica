import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the real client module (type-only imports are erased), as livePreflight.test.js does.
const source = readFileSync(new URL('../../src/safetyRules.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
} });
const { safetyRules } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const byRule = rules => Object.fromEntries(rules.map(r => [r.rule, r]));

test('thresholds the server reports come from /api/health with their env variable', () => {
  const rules = byRule(safetyRules({ maxRugScore: 40, minLiquidityUsd: 1000, maxPriceImpactPct: 5 }));
  assert.deepEqual([rules['Normalised risk score'].threshold, rules['Normalised risk score'].setting], ['≤ 40', 'GMGN_MAX_RUG_SCORE']);
  assert.deepEqual([rules['Market liquidity'].threshold, rules['Market liquidity'].setting], ['≥ $1,000', 'GMGN_MIN_LIQUIDITY_USD']);
  assert.deepEqual([rules['Price impact on the quote'].threshold, rules['Price impact on the quote'].setting], ['≤ 5%', 'GMGN_MAX_PRICE_IMPACT_PCT']);
  // A liquidity floor of 0 turns the check off on the server.
  assert.equal(byRule(safetyRules({ minLiquidityUsd: 0 }))['Market liquidity'].threshold, 'off (set to 0)');
});

test('missing values are never filled in', () => {
  const offline = byRule(safetyRules(null));
  assert.equal(offline['Normalised risk score'].threshold, 'unknown · server not reachable');
  assert.equal(offline['Market liquidity'].threshold, 'unknown · server not reachable');
  const partial = byRule(safetyRules({ maxRugScore: 40 }));
  assert.equal(partial['Price impact on the quote'].threshold, 'not reported');
});

test('rules match the server: blocks fail closed, only informational findings warn', () => {
  const rules = safetyRules({ maxRugScore: 40, minLiquidityUsd: 1000, maxPriceImpactPct: 5 });
  assert.deepEqual(rules.filter(r => r.effect === 'WARN').map(r => r.rule), [
    'Mint authority still active', 'Warn-level risks', 'Mintable', 'One scanner unavailable',
  ]);
  const r = byRule(rules);
  // server/rugScanner.js blocks a largest holder at 40% or more; it is not a warning.
  assert.deepEqual([r['Largest holder'].threshold, r['Largest holder'].effect], ['under 40% · data required', 'BLOCK']);
  assert.equal(r['Both scanners unavailable'].effect, 'BLOCK');
  assert.ok(rules.every(x => x.setting === 'fixed' || /^GMGN_[A-Z_]+$/.test(x.setting)));
});
