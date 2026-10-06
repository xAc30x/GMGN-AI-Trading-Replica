import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the real client module (type-only imports are erased), as livePreflight.test.js does.
const source = readFileSync(new URL('../../src/setupChecklist.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
} });
const { setupSteps, modeReadiness, limitRows, settingsSections } =
  await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

// Field names as server/index.js reports them in /api/health.
const health = { solLiveEnabled: true, solBroadcastEnabled: true, serverSigningDisabled: true,
  maxNativeAmount: 0.05, maxPortfolioSol: 0.1, maxOpenPositions: 5, maxSlippageBps: 300,
  maxRugScore: 40, minLiquidityUsd: 25000, maxPriceImpactPct: 5 };
const ready = { health, tokenPresent: true, walletAddress: '7Gh2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaak9Pq', walletName: 'Phantom', rpcIsPublic: false };
const readiness = input => Object.fromEntries(modeReadiness(setupSteps(input)).map(r => [r.mode, r.blockedBy]));

test('fully configured setup leaves every mode ready', () => {
  assert.deepEqual(readiness(ready), { SHADOW: null, PAPER: null, LIVE: null });
  const steps = setupSteps(ready);
  assert.deepEqual(steps.map(s => s.status), ['pass', 'pass', 'pass', 'pass', 'info']);
  assert.equal(steps[1].detail, 'Phantom · 7Gh2…k9Pq');
});

test('each missing piece blocks only the modes that need it', () => {
  assert.deepEqual(readiness({ ...ready, tokenPresent: false }), { SHADOW: null, PAPER: 1, LIVE: 1 });
  assert.deepEqual(readiness({ ...ready, walletAddress: null }), { SHADOW: null, PAPER: null, LIVE: 2 });
  assert.deepEqual(readiness({ ...ready, health: { ...health, solBroadcastEnabled: false } }), { SHADOW: null, PAPER: null, LIVE: 4 });
  assert.deepEqual(readiness({ ...ready, health: { ...health, solLiveEnabled: false } }), { SHADOW: null, PAPER: 4, LIVE: 4 });
  assert.deepEqual(readiness({ ...ready, health: null }), { SHADOW: null, PAPER: 4, LIVE: 4 });
  // The first failing step is named when several fail.
  assert.deepEqual(readiness({ ...ready, tokenPresent: false, walletAddress: null }), { SHADOW: null, PAPER: 1, LIVE: 1 });
});

test('a public RPC is a warning, not a blocker', () => {
  const steps = setupSteps({ ...ready, rpcIsPublic: true });
  assert.equal(steps[2].status, 'warn');
  assert.equal(steps[2].detail, 'public mainnet');
  assert.deepEqual(readiness({ ...ready, rpcIsPublic: true }), { SHADOW: null, PAPER: null, LIVE: null });
});

test('hard limits list only what the server reports', () => {
  assert.deepEqual(limitRows(health), [
    ['per trade', '0.05 SOL'], ['exposure', '0.1 SOL'], ['open positions', '5'], ['slippage', '3.00%'],
    ['rug score', '≤ 40'], ['min liquidity', '$25,000'], ['price impact', '5%'],
  ]);
  assert.deepEqual(limitRows({ maxNativeAmount: 0.02 }), [['per trade', '0.02 SOL']]);
  assert.deepEqual(limitRows(null), []);
});

test('settings sections cover every setup step once and show the worst status of their steps', () => {
  const sections = settingsSections(setupSteps(ready));
  assert.deepEqual(sections.map(s => [s.label, s.status]), [
    ['Access & wallet', 'pass'],
    ['Network & RPC', 'pass'],
    ['Trade limits', 'info'],
    ['Execution gates', 'pass'],
  ]);
  assert.deepEqual(sections.flatMap(s => s.steps).sort(), [1, 2, 3, 4, 5]);
  // A missing wallet fails the access section even though the token is fine.
  const noWallet = settingsSections(setupSteps({ ...ready, walletAddress: null }));
  assert.equal(noWallet[0].status, 'fail');
  // A public RPC is a warning, and broadcast off is a warning on the gates.
  const warn = settingsSections(setupSteps({ ...ready, rpcIsPublic: true, health: { ...health, solBroadcastEnabled: false } }));
  assert.equal(warn[1].status, 'warn');
  assert.equal(warn[3].status, 'warn');
  // With the server unreachable, the network and gate sections fail.
  const down = settingsSections(setupSteps({ ...ready, health: null }));
  assert.deepEqual(down.map(s => s.status), ['pass', 'fail', 'info', 'fail']);
});
