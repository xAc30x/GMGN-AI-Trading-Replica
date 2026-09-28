import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
// Compile the actual pure client modules with the project's compiler. No native
// Node TypeScript support or browser globals are required for these unit tests.
async function loadTs(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions:{
    target:ts.ScriptTarget.ES2023, module:ts.ModuleKind.ESNext,
  } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
const { confirmSwap } = await loadTs('../../src/solana/confirmSwap.ts');
const {
  recordLivePosition,
  loadLivePositions,
  saveLivePositions,
  loadTradeAttempts,
  portfolioLimitBlocker,
  reconcileWalletTrades,
  withWalletTrade,
} = await loadTs('../../src/positions.ts');

const fast = { intervalMs: 1, timeoutMs: 200 };
const conn = (statuses, height = 0) => { let i = 0; return {
  getSignatureStatuses: async () => ({ value: [statuses[Math.min(i++, statuses.length - 1)]] }),
  getBlockHeight: async () => height,
}; };
test('confirmation propagates execution errors', async () => {
  await assert.rejects(confirmSwap(conn([{ err:{ InstructionError:[0,'failed'] } }]), 'signature', 'h', 123, fast), /Transaction failed/);
});
test('confirmed successful transactions remain successful after polling', async () => {
  await confirmSwap(conn([null, { err:null, confirmationStatus:'processed' }, { err:null, confirmationStatus:'confirmed' }]), 'sig', 'hash', 123, fast);
});
test('expired blockhash with no status preserves the signature in the error', async () => {
  await assert.rejects(confirmSwap(conn([null], 999), 'recover-this-signature','hash',123, fast), /recover-this-signature.*before retrying/);
});
test('timeout preserves the signature in the error', async () => {
  const c = { getSignatureStatuses: async () => { throw Error('net'); }, getBlockHeight: async () => 0 };
  await assert.rejects(confirmSwap(c, 'recover-this-signature','hash',123, fast), /recover-this-signature.*before retrying/);
});
const pos = { id:'p', symbol:'SAME', chain:'SOL', address:'mintA', walletAddress:'walletA',
  signature:'sig', demo:false, sizeSol:0.01, pnlPct:0, entryAge:'0m' };
test('positions separate demo, wallet and mint identities', () => {
  for (const other of [{ ...pos, demo:true }, { ...pos,address:'mintB' }, { ...pos,walletAddress:'walletB' }]) {
    assert.equal(recordLivePosition([other],pos).length,2);
  }
  const merged = recordLivePosition([pos],{ ...pos, id:'new', signature:'sig-new', sizeSol:0.02 });
  assert.equal(merged.length,1); assert.equal(merged[0].sizeSol,0.03);
});
test('position reconciliation is idempotent by transaction signature', () => {
  const first = recordLivePosition([], pos);
  assert.deepEqual(recordLivePosition(first, pos), first);
  const second = recordLivePosition(first, { ...pos, id:'p2', signature:'sig-2', sizeSol:0.02 });
  assert.equal(second.length, 1);
  assert.equal(second[0].sizeSol, 0.03);
  assert.deepEqual(second[0].tradeSignatures, ['sig', 'sig-2']);
});
test('only live wallet-scoped records survive reload', t => {
  const storage = new Map();
  const prior = globalThis.localStorage;
  globalThis.localStorage = { getItem:k => storage.get(k), setItem:(k,v) => storage.set(k,v) };
  t.after(() => { if (prior === undefined) delete globalThis.localStorage; else globalThis.localStorage = prior; });
  saveLivePositions([pos,{ ...pos, demo:true }]);
  assert.deepEqual(loadLivePositions(),[pos]);
});

test('portfolio caps include existing holdings and unresolved buys', t => {
  const storage = new Map();
  const prior = globalThis.localStorage;
  globalThis.localStorage = { getItem:k => storage.get(k), setItem:(k,v) => storage.set(k,v) };
  t.after(() => { if (prior === undefined) delete globalThis.localStorage; else globalThis.localStorage = prior; });
  const input = { walletAddress:'walletA', mint:'mintB', amountSol:0.05,
    limits:{ maxPortfolioSol:0.05, maxOpenPositions:2 } };
  assert.match(portfolioLimitBlocker({ ...input, positions:[pos] }), /Portfolio cap exceeded/);
  assert.match(portfolioLimitBlocker({ ...input,
    attempts:[{ walletAddress:'walletA', mint:'mintB', side:'buy', amountSol:0.04, status:'unknown' }] }), /Portfolio cap exceeded/);
  assert.match(portfolioLimitBlocker({ ...input, limits:{ maxPortfolioSol:1, maxOpenPositions:1 },
    positions:[pos] }), /Open-position cap reached/);
  assert.equal(portfolioLimitBlocker({ ...input, mint:'mintA', amountSol:0.02, positions:[pos] }), null);
});

test('reconciliation recovers confirmed buys without duplicating positions', async t => {
  const storage = new Map();
  const prior = globalThis.localStorage;
  globalThis.localStorage = { getItem:k => storage.get(k), setItem:(k,v) => storage.set(k,v) };
  t.after(() => { if (prior === undefined) delete globalThis.localStorage; else globalThis.localStorage = prior; });
  const now = Date.now();
  storage.set('gmgn.trades.v1', JSON.stringify([{
    id:'recover-1', fingerprint:'walletA:buy:mintA:0.010000000', walletAddress:'walletA',
    mint:'mintA', symbol:'SAME', side:'buy', amountSol:0.01, signature:'recover-signature',
    status:'unknown', createdAt:now, updatedAt:now,
  }]));
  const connection = { getSignatureStatuses: async signatures => ({
    value:signatures.map(() => ({ err:null, confirmationStatus:'confirmed' })),
  }) };
  const attempts = await reconcileWalletTrades(connection, 'walletA');
  assert.equal(attempts[0].status, 'confirmed');
  assert.equal(loadLivePositions().length, 1);
  assert.equal(loadLivePositions()[0].signature, 'recover-signature');
  await reconcileWalletTrades(connection, 'walletA');
  assert.equal(loadLivePositions().length, 1);
});

test('wallet lock serializes tabs and rejects a matching duplicate', async t => {
  const storage = new Map();
  const previousStorage = globalThis.localStorage;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.localStorage = { getItem:k => storage.get(k), setItem:(k,v) => storage.set(k,v) };
  let tail = Promise.resolve();
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{ locks:{ request:async (_name, _options, callback) => {
    const before = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await before;
    try { return await callback(); } finally { release(); }
  } } } });
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  });

  let releaseAction;
  let started;
  const actionGate = new Promise(resolve => { releaseAction = resolve; });
  const actionStarted = new Promise(resolve => { started = resolve; });
  const input = { walletAddress:'walletA', mint:'mintA', side:'buy', amountSol:0.01 };
  const first = withWalletTrade(input, async attempt => { started(); await actionGate; return attempt.id; });
  await actionStarted;
  const duplicate = withWalletTrade(input, async () => 'must not submit');
  releaseAction();
  const [firstResult, duplicateResult] = await Promise.allSettled([first, duplicate]);
  assert.equal(firstResult.status, 'fulfilled');
  assert.equal(duplicateResult.status, 'rejected');
  assert.match(duplicateResult.reason.message, /Matching trade is already in progress/);
  assert.equal(loadTradeAttempts().length, 1);
});

const { computePnl, readTokenBalance } = await loadTs('../../src/pnl.ts');
test('wallet valuation sums matching accounts and rejects malformed balances instead of hiding holdings', () => {
  const account = (amount, decimals = 6) => ({ account: { data: { parsed: { info: {
    owner: 'wallet', mint: 'mint', tokenAmount: { amount, decimals },
  } } } } });
  assert.deepEqual(readTokenBalance([account('1000000'), account('2000000')], 'wallet', 'mint'), { atomic: '3000000', tokenAmount: 3 });
  assert.deepEqual(readTokenBalance([], 'wallet', 'mint'), { atomic: '0', tokenAmount: 0 });
  assert.throws(() => readTokenBalance([{}], 'wallet', 'mint'), /Invalid/);
  assert.throws(() => readTokenBalance([account('1')], 'other', 'mint'), /Invalid/);
  assert.throws(() => readTokenBalance([account('1'), account('1', 9)], 'wallet', 'mint'), /Invalid/);
  assert.deepEqual(computePnl(0.01, '20000000'), { valueSol: 0.02, pnlPct: 100 });
});
