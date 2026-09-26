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

test('confirmation uses submitted blockhash and propagates execution errors', async () => {
  const seen = [];
  const connection = { confirmTransaction: async strategy => {
    seen.push(strategy); return { value:{ err:{ InstructionError:[0,'failed'] } } };
  }};
  await assert.rejects(confirmSwap(connection, 'signature', 'submitted-blockhash', 123), /Transaction failed/);
  assert.deepEqual(seen[0], { signature:'signature', blockhash:'submitted-blockhash', lastValidBlockHeight:123 });
});
test('confirmed successful transactions remain successful', async () => {
  await confirmSwap({ confirmTransaction:async () => ({ value:{ err:null } }) }, 'sig', 'hash', 123);
});
test('unknown confirmation preserves the signature in the error', async () => {
  await assert.rejects(confirmSwap({ confirmTransaction:async () => { throw Error('timeout'); } },
    'recover-this-signature','hash',123), /recover-this-signature.*before retrying/);
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
