import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the real client module (type-only imports are erased), as livePreflight.test.js does.
const source = readFileSync(new URL('../../src/statusSummary.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
} });
const { limitsSummary, serverSigning } =
  await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

// Field names and defaults as server/index.js reports them in /api/health.
const health = { maxNativeAmount: 0.05, maxPortfolioSol: 0.1, maxOpenPositions: 5, maxSlippageBps: 300,
  mintSafetyRequired: true, serverSigningDisabled: true };

test('limits summary reads every hard limit from server status', () => {
  assert.equal(limitsSummary(health), 'limits 0.05 SOL/trade · 0.1 SOL total · 5 positions · 3% slippage · scans fail-closed');
  assert.equal(limitsSummary({ ...health, maxOpenPositions: 1, maxSlippageBps: 150 }),
    'limits 0.05 SOL/trade · 0.1 SOL total · 1 position · 1.5% slippage · scans fail-closed');
});

test('limits summary never fills in defaults the server did not send', () => {
  assert.equal(limitsSummary(null), 'limits: server status not loaded');
  assert.equal(limitsSummary({}), 'limits: not reported by server');
  assert.equal(limitsSummary({ maxNativeAmount: 0.02 }), 'limits 0.02 SOL/trade');
  assert.equal(limitsSummary({ ...health, mintSafetyRequired: false }).includes('fail-closed'), false);
});

test('server signing is only reported as disabled when the server says so', () => {
  assert.equal(serverSigning(health), 'disabled');
  assert.equal(serverSigning({ ...health, serverSigningDisabled: false }), 'enabled');
  assert.equal(serverSigning({}), 'unknown');
  assert.equal(serverSigning(null), 'unknown');
});
