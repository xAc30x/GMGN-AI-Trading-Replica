import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { readSettlement, syncLiveTrades, summarizeLiveTrades, liveTradeRecord } from '../liveTrades.js';
import { authorizeBroadcast, inspectBroadcast, claimBroadcast, completeBroadcast, sentBroadcasts } from '../tradeLedger.js';

const SOL = 'So11111111111111111111111111111111111111112';
const wallet = Keypair.generate().publicKey;
const W = wallet.toBase58();
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-live-trades-'));
  const saved = { trades: process.env.GMGN_LIVE_TRADES_PATH, ledger: process.env.GMGN_TRADE_LEDGER_PATH };
  process.env.GMGN_LIVE_TRADES_PATH = path.join(dir, 'live.sqlite');
  process.env.GMGN_TRADE_LEDGER_PATH = path.join(dir, 'ledger.json');
  t.after(() => {
    for (const [key, name] of [['trades', 'GMGN_LIVE_TRADES_PATH'], ['ledger', 'GMGN_TRADE_LEDGER_PATH']]) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return process.env.GMGN_LIVE_TRADES_PATH;
}

// Shaped like Connection.getTransaction output for a v0 transaction.
function chainTx({ slot = 10, payer = wallet, solBefore, solAfter, tokensBefore, tokensAfter, fee = 5000, err = null, owner = W }) {
  const balance = amount => amount == null ? [] : [{ accountIndex: 2, mint: MINT, owner, uiTokenAmount: { amount: String(amount) } }];
  return { slot, blockTime: 1700000000, transaction: { message: { staticAccountKeys: [payer] } },
    meta: { err, fee, preBalances: [solBefore, 0], postBalances: [solAfter, 0],
      preTokenBalances: balance(tokensBefore), postTokenBalances: balance(tokensAfter) } };
}

test('a confirmed buy records every lamport that left the wallet and the tokens received', () => {
  const s = readSettlement(chainTx({ solBefore: 1_000_000_000, solAfter: 987_000_000, tokensBefore: null, tokensAfter: 5000 }), { wallet: W, mint: MINT });
  assert.deepEqual(s, { status: 'confirmed', slot: 10, blockTime: 1700000000000,
    solDeltaLamports: '-13000000', tokenDeltaAtomic: '5000', feeLamports: '5000' });
});

test('unknown, foreign and malformed transactions are not recorded as trades', () => {
  assert.equal(readSettlement(null, { wallet: W, mint: MINT }), null);
  assert.throws(() => readSettlement(chainTx({ payer: Keypair.generate().publicKey, solBefore: 1, solAfter: 1 }), { wallet: W, mint: MINT }), /fee payer/);
  assert.throws(() => readSettlement({ slot: 1, transaction: { message: { staticAccountKeys: [wallet] } } }, { wallet: W, mint: MINT }), /balance details/);
  // Token balances held by someone else do not count as the wallet's.
  const other = readSettlement(chainTx({ solBefore: 10, solAfter: 5, tokensBefore: 0, tokensAfter: 99, owner: 'someone' }), { wallet: W, mint: MINT });
  assert.equal(other.tokenDeltaAtomic, '0');
});

test('average cost: fees and rent are part of the cost, partial sells realise their share, failed fees are losses', () => {
  const trade = (slot, side, sol, tokens, extra = {}) => ({ tradeId: `t-${slot}`, slot, side, mint: MINT, wallet: W,
    status: 'confirmed', solDeltaLamports: String(sol), tokenDeltaAtomic: String(tokens), feeLamports: '5000', ...extra });
  const { positions, totals } = summarizeLiveTrades([
    trade(3, 'close', 6_000_000, -500),            // sells half for 0.006 SOL
    trade(1, 'buy', -12_000_000, 1000),            // 0.01 SOL swap + fees + rent
    trade(2, 'buy', -1_000, 0, { status: 'failed' }), // failed, fee still paid
  ]);
  const p = positions[0];
  assert.equal(p.boughtLamports, '12000000');
  assert.equal(p.soldLamports, '6000000');
  assert.equal(p.heldAtomic, '500');
  assert.equal(p.costLamports, '6000000');
  assert.equal(p.realisedPnlLamports, String(6_000_000 - 6_000_000 - 1_000));
  assert.equal(p.failed, 1);
  assert.equal(totals.feesLamports, '15000');
  assert.equal(totals.openCostLamports, '6000000');
});

test('selling tokens the record never saw bought counts them at zero cost', () => {
  const { positions } = summarizeLiveTrades([{ tradeId: 'x', slot: 1, side: 'close', mint: MINT, wallet: W,
    status: 'confirmed', solDeltaLamports: '400', tokenDeltaAtomic: '-10', feeLamports: '5000' }]);
  assert.equal(positions[0].realisedPnlLamports, '400');
  assert.equal(positions[0].heldAtomic, '0');
});

test('sync stores each sent trade once, waits for unseen ones and keeps going after a lookup error', async t => {
  temporary(t);
  const broadcasts = () => [
    { tradeId: 'trade-buy-000001', wallet: W, side: 'buy', signature: 'sigbuy1111', intent: { inputMint: SOL, outputMint: MINT } },
    { tradeId: 'trade-wait-00001', wallet: W, side: 'buy', signature: 'sigwait111', intent: { inputMint: SOL, outputMint: MINT } },
    { tradeId: 'trade-bad-000001', wallet: W, side: 'close', signature: 'sigbad1111', intent: { inputMint: MINT, outputMint: SOL } },
  ];
  const lookups = [];
  const connection = { getTransaction: async (signature, options) => {
    lookups.push(signature);
    assert.deepEqual(options, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (signature === 'sigbuy1111') return chainTx({ solBefore: 100_000_000, solAfter: 88_000_000, tokensBefore: 0, tokensAfter: 1000 });
    if (signature === 'sigbad1111') throw new Error('RPC down');
    return null;
  } };
  const first = await syncLiveTrades({ connection, broadcasts, now: () => 5 });
  assert.equal(first.stored, 1); assert.equal(first.waiting, 2); assert.match(first.error, /RPC down/);
  const second = await syncLiveTrades({ connection, broadcasts });
  assert.equal(second.stored, 0);
  assert.equal(lookups.filter(s => s === 'sigbuy1111').length, 1, 'a stored trade is never looked up again');
  const record = liveTradeRecord({ wallet: W });
  assert.equal(record.trades.length, 1);
  assert.equal(record.positions[0].costLamports, '12000000');
  assert.equal(liveTradeRecord({ wallet: Keypair.generate().publicKey.toBase58() }).trades.length, 0);
  assert.equal(fs.statSync(process.env.GMGN_LIVE_TRADES_PATH).mode & 0o777, 0o600);
});

test('the trade ledger lists only broadcasts that were sent, with their signature and intent', t => {
  temporary(t);
  const signer = Keypair.generate();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message());
  const intent = { inputMint: SOL, outputMint: MINT, inAmount: '100' };
  authorizeBroadcast({ tradeId: 'ledger-sent-0001', swapTransaction: Buffer.from(tx.serialize()).toString('base64'),
    walletAddress: signer.publicKey.toBase58(), side: 'buy', mode: 'LIVE', lastValidBlockHeight: 100, intent });
  assert.equal(sentBroadcasts().length, 0, 'authorized but unsent trades are not listed');
  tx.sign([signer]);
  const candidate = inspectBroadcast('ledger-sent-0001', Buffer.from(tx.serialize()).toString('base64'));
  claimBroadcast(candidate, 50);
  assert.equal(sentBroadcasts().length, 1, 'a pending send may have landed, so it is listed');
  completeBroadcast('ledger-sent-0001', candidate.signature);
  const [sent] = sentBroadcasts();
  assert.equal(sent.signature, candidate.signature); assert.equal(sent.side, 'buy');
  assert.deepEqual(sent.intent, intent); assert.equal(sent.wallet, signer.publicKey.toBase58());
});

test('the live trade route needs the access token and rejects a malformed wallet', async t => {
  temporary(t);
  const { default: express } = await import('express');
  const { registerLiveTradeRoutes } = await import('../liveTradeRoutes.js');
  const app = express();
  const requireLocalToken = (req, res, next) => req.get('x-gmgn-token') === 'ok' ? next() : res.status(401).json({ ok: false });
  registerLiveTradeRoutes(app, { requireLocalToken, connection: { getTransaction: async () => null } });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/live/trades`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(`${url}?wallet=not-a-wallet!`, { headers: { 'x-gmgn-token': 'ok' } })).status, 400);
  const body = await (await fetch(`${url}?wallet=${W}`, { headers: { 'x-gmgn-token': 'ok' } })).json();
  assert.equal(body.ok, true); assert.deepEqual(body.trades, []);
  assert.deepEqual(body.sync, { stored: 0, waiting: 0, error: null });
});
