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
const { recordLivePosition, loadLivePositions, saveLivePositions } = await loadTs('../../src/positions.ts');

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
  const merged = recordLivePosition([pos],{ ...pos, id:'new', sizeSol:0.02 });
  assert.equal(merged.length,1); assert.equal(merged[0].sizeSol,0.03);
});
test('only live wallet-scoped records survive reload', t => {
  const storage = new Map();
  const prior = globalThis.localStorage;
  globalThis.localStorage = { getItem:k => storage.get(k), setItem:(k,v) => storage.set(k,v) };
  t.after(() => { if (prior === undefined) delete globalThis.localStorage; else globalThis.localStorage = prior; });
  saveLivePositions([pos,{ ...pos, demo:true }]);
  assert.deepEqual(loadLivePositions(),[pos]);
});
