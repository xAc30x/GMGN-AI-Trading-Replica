import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/exitAlerts.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
const { exitAlert, parseExitRules, DEFAULT_EXIT_RULES } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const rules = { stopLossPct: -20, takeProfitPct: 30 };

test('defaults match the paper model exits', () => {
  assert.deepEqual({ ...DEFAULT_EXIT_RULES }, { stopLossPct: -20, takeProfitPct: 30 });
});

test('alerts fire at and beyond each level, and not between them', () => {
  assert.equal(exitAlert({ pnlPct: -19.9, exitValueSol: 1 }, rules), null);
  assert.equal(exitAlert({ pnlPct: 29.9, exitValueSol: 1 }, rules), null);
  const stop = exitAlert({ pnlPct: -20, exitValueSol: 1 }, rules);
  assert.equal(stop.kind, 'stop_loss'); assert.equal(stop.fromQuote, true);
  assert.equal(stop.text, 'Stop-loss reached (-20%): -20.0% by sell-now quote.');
  const target = exitAlert({ pnlPct: 45.25, exitValueSol: 1 }, rules);
  assert.equal(target.kind, 'take_profit'); assert.equal(target.text, 'Profit target reached (+30%): +45.3% by sell-now quote.');
});

test('a market estimate or stale quote still alerts but says the sale price may be lower', () => {
  const estimate = exitAlert({ pnlPct: -40 }, rules);
  assert.equal(estimate.fromQuote, false); assert.match(estimate.text, /market estimate; the real sale price may be lower/);
  assert.equal(exitAlert({ pnlPct: -40, exitValueSol: 1, exitStale: true }, rules).fromQuote, false);
});

test('no alert without a usable valuation', () => {
  assert.equal(exitAlert(undefined, rules), null);
  assert.equal(exitAlert({ pnlPct: -50, error: 'Wallet balance is stale' }, rules), null);
  assert.equal(exitAlert({ pnlPct: -50, noBalance: true }, rules), null);
  assert.equal(exitAlert({}, rules), null);
  assert.equal(exitAlert({ pnlPct: Number.NaN }, rules), null);
});

test('saved levels outside the allowed range fall back to the defaults field by field', () => {
  assert.deepEqual(parseExitRules({ stopLossPct: -10, takeProfitPct: 50 }), { stopLossPct: -10, takeProfitPct: 50 });
  assert.deepEqual(parseExitRules({ stopLossPct: 10, takeProfitPct: 50 }), { stopLossPct: -20, takeProfitPct: 50 });
  assert.deepEqual(parseExitRules({ stopLossPct: -10, takeProfitPct: -5 }), { stopLossPct: -10, takeProfitPct: 30 });
  assert.deepEqual(parseExitRules({ stopLossPct: '-10' }), { stopLossPct: -20, takeProfitPct: 30 });
  assert.deepEqual(parseExitRules(null), { stopLossPct: -20, takeProfitPct: 30 });
  assert.deepEqual(parseExitRules({ stopLossPct: -100 }), { stopLossPct: -20, takeProfitPct: 30 });
});
