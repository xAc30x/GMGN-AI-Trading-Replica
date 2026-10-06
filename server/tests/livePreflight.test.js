import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the real client module (type-only imports are erased), as clientRegression.test.js does.
const source = readFileSync(new URL('../../src/livePreflight.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
} });
const { livePreflight } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const readyHealth = { solLiveEnabled: true, solBroadcastEnabled: true };
const ready = {
  chain: 'SOL',
  health: readyHealth,
  tokenPresent: true,
  walletAddress: '7Gh2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaak9Pq',
  walletName: 'Phantom',
  rpcIsPublic: false,
  unresolvedSignatures: 0,
};
const failures = items => items.filter(i => i.status === 'fail').map(i => i.label);
const warnings = items => items.filter(i => i.status === 'warn').map(i => i.label);

test('fully configured SOL setup passes every LIVE preflight check', () => {
  const items = livePreflight(ready);
  assert.deepEqual(failures(items), []);
  assert.deepEqual(warnings(items), []);
  assert.equal(items.find(i => i.label === 'Wallet connected').detail, 'Phantom 7Gh2…k9Pq');
});

test('each missing SOL LIVE precondition is a blocking failure', () => {
  assert.deepEqual(failures(livePreflight({ ...ready, tokenPresent: false })), ['Access token']);
  assert.deepEqual(failures(livePreflight({ ...ready, walletAddress: null })), ['Wallet connected']);
  assert.deepEqual(failures(livePreflight({ ...ready, health: { ...readyHealth, solBroadcastEnabled: false } })), ['GMGN_SOL_BROADCAST']);
  assert.deepEqual(failures(livePreflight({ ...ready, health: { ...readyHealth, solLiveEnabled: false } })), ['GMGN_LIVE']);
});

test('unreachable server fails closed', () => {
  assert.deepEqual(failures(livePreflight({ ...ready, health: null })), ['Server status']);
});

test('public RPC and unresolved signatures warn without blocking', () => {
  const items = livePreflight({ ...ready, rpcIsPublic: true, unresolvedSignatures: 2 });
  assert.deepEqual(failures(items), []);
  assert.deepEqual(warnings(items), ['RPC', 'Unresolved signatures']);
});

test('non-SOL chains need no wallet or broadcast because nothing is signed', () => {
  const items = livePreflight({ ...ready, chain: 'BSC', walletAddress: null, health: { solLiveEnabled: true, solBroadcastEnabled: false } });
  assert.deepEqual(failures(items), []);
  assert.ok(!items.some(i => i.label === 'Wallet connected' || i.label === 'GMGN_SOL_BROADCAST'));
});
