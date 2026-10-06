import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { authorizeBroadcast, inspectBroadcast, claimBroadcast, completeBroadcast } from '../tradeLedger.js';

const moduleUrl = new URL('../tradeLedger.js', import.meta.url).href;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-broadcast-ledger-'));
  const previous = process.env.GMGN_TRADE_LEDGER_PATH;
  const file = path.join(dir, 'legacy.json');
  process.env.GMGN_TRADE_LEDGER_PATH = file;
  t.after(() => {
    if (previous === undefined) delete process.env.GMGN_TRADE_LEDGER_PATH;
    else process.env.GMGN_TRADE_LEDGER_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const wallet = Keypair.generate();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [],
  }).compileToV0Message());
  const auth = { tradeId: 'ledger-fixture-original', swapTransaction: Buffer.from(tx.serialize()).toString('base64'),
    walletAddress: wallet.publicKey.toBase58(), side: 'close', mode: 'LIVE', lastValidBlockHeight: 100,
    intent: { inputMint: wallet.publicKey.toBase58(), outputMint: 'So11111111111111111111111111111111111111112', inAmount: '100' } };
  tx.sign([wallet]);
  return { auth, payload: Buffer.from(tx.serialize()).toString('base64'), file };
}
function child(script, env) {
  return spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}
function message(worker) {
  return new Promise((resolve, reject) => {
    let errors = '';
    const onErrorData = chunk => { errors += chunk; };
    const timer = setTimeout(() => finish(new Error(`Worker timeout: ${errors}`)), 10000);
    const onMessage = data => finish(null, data);
    const onError = error => finish(error);
    const onExit = code => finish(new Error(`Worker exited ${code}: ${errors}`));
    function finish(error, result) {
      clearTimeout(timer);
      worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
      worker.stderr.off('data', onErrorData);
      if (error) reject(error); else resolve(result);
    }
    worker.stderr.on('data', onErrorData);
    worker.once('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
  });
}

test('independent processes racing a pre-inspected authorization obtain only one durable claim', async t => {
  const { auth, payload } = fixture(t);
  authorizeBroadcast(auth);
  const script = `
    import { inspectBroadcast, claimBroadcast } from ${JSON.stringify(moduleUrl)};
    const candidate = inspectBroadcast(process.env.TEST_TRADE, process.env.TEST_PAYLOAD);
    process.send('ready');
    process.once('message', () => {
      try { process.send(claimBroadcast(candidate, 1).kind); }
      catch (error) { process.send({ status: error.status, message: error.message }); }
      process.disconnect();
    });`;
  const workers = [0, 1].map(() => child(script, { TEST_TRADE: auth.tradeId, TEST_PAYLOAD: payload }));
  t.after(() => { for (const worker of workers) worker.kill(); });
  assert.deepEqual(await Promise.all(workers.map(message)), ['ready', 'ready']);
  const pending = workers.map(message);
  for (const worker of workers) worker.send('claim');
  const results = await Promise.all(pending);
  assert.equal(results.filter(result => result === 'claimed').length, 1);
  assert.equal(results.filter(result => result?.status === 409).length, 1);
  assert.throws(() => inspectBroadcast(auth.tradeId, payload), /pending or uncertain/);
});

test('restart preserves pending claims; accepted cache verifies the exact signature and payload', async t => {
  const { auth, payload, file } = fixture(t);
  authorizeBroadcast(auth);
  const candidate = inspectBroadcast(auth.tradeId, payload);
  claimBroadcast(candidate, 1);
  const worker = child(`
    import { inspectBroadcast } from ${JSON.stringify(moduleUrl)};
    try { process.send(inspectBroadcast(process.env.TEST_TRADE, process.env.TEST_PAYLOAD)); }
    catch (error) { process.send({ status: error.status, message: error.message }); }
    process.disconnect();`, { TEST_TRADE: auth.tradeId, TEST_PAYLOAD: payload });
  t.after(() => worker.kill());
  assert.equal((await message(worker)).status, 409);
  assert.throws(() => completeBroadcast(auth.tradeId, 'wrong-signature'), /signature mismatch/);
  assert.throws(() => inspectBroadcast(auth.tradeId, payload), /pending or uncertain/);
  completeBroadcast(auth.tradeId, candidate.signature);
  assert.equal(inspectBroadcast(auth.tradeId, payload).kind, 'cached');
  assert.equal(fs.statSync(`${file}.sqlite`).mode & 0o777, 0o600);
});

test('authorizations cannot overwrite trade IDs, reuse messages, or authorize PAPER or signed builds', t => {
  const { auth, payload } = fixture(t);
  assert.throws(() => authorizeBroadcast({ ...auth, mode: 'PAPER' }), /Only LIVE/);
  assert.throws(() => authorizeBroadcast({ ...auth, swapTransaction: payload }), /must be unsigned/);
  assert.throws(() => authorizeBroadcast({ ...auth, walletAddress: Keypair.generate().publicKey.toBase58() }), /requested wallet/);
  assert.throws(() => authorizeBroadcast({ ...auth, lastValidBlockHeight: NaN }), /expiry/);
  authorizeBroadcast(auth);
  assert.throws(() => authorizeBroadcast(auth), /already authorized/);
  assert.throws(() => authorizeBroadcast({ ...auth, tradeId: 'ledger-fixture-another' }), /already authorized/);
  assert.throws(() => claimBroadcast(inspectBroadcast(auth.tradeId, payload), 101), /expired/);
  assert.throws(() => claimBroadcast(inspectBroadcast(auth.tradeId, payload), NaN), /block height/);
});

test('legacy pending claims migrate once and block old IDs and signed payloads without deleting JSON', t => {
  const { auth, payload, file } = fixture(t);
  const legacyId = 'legacy-fixture-pending';
  const text = JSON.stringify({ [legacyId]: {
    transactionHash: crypto.createHash('sha256').update(payload).digest('hex'), state: 'pending', createdAt: 1,
  } });
  fs.writeFileSync(file, text);
  assert.throws(() => authorizeBroadcast({ ...auth, tradeId: legacyId }), /already authorized/);
  authorizeBroadcast(auth);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.throws(() => inspectBroadcast(auth.tradeId, payload), /Legacy broadcast/);
  // The SQLite tombstone must remain even if the retained JSON is later removed.
  fs.unlinkSync(file);
  assert.throws(() => inspectBroadcast(auth.tradeId, payload), /Legacy broadcast/);
});

test('invalid legacy ledger is never reset into an empty authorization store', t => {
  const { auth, file } = fixture(t);
  fs.writeFileSync(file, '[]');
  assert.throws(() => authorizeBroadcast(auth), /Invalid legacy/);
  assert.equal(fs.readFileSync(file, 'utf8'), '[]');
});
