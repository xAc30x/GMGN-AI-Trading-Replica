import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Connection } from '@solana/web3.js';
import { app } from '../index.js';

const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const sol = 'So11111111111111111111111111111111111111112';
const flags = Object.fromEntries(['non_transferable','closable','transfer_hook','freezable','mintable']
  .map(k => [k,{ status:'0' }]));

test('route invariants: auth, LIVE gate, cap, denylist, fresh quote, closes', async t => {
  const oldLive = process.env.GMGN_LIVE;
  const oldToken = process.env.GMGN_LOCAL_TOKEN;
  process.env.GMGN_LIVE='1';
  process.env.GMGN_LOCAL_TOKEN='test-only-local-token';
  t.after(() => {
    if (oldLive === undefined) delete process.env.GMGN_LIVE; else process.env.GMGN_LIVE=oldLive;
    if (oldToken === undefined) delete process.env.GMGN_LOCAL_TOKEN; else process.env.GMGN_LOCAL_TOKEN=oldToken;
  });
  t.mock.method(Connection.prototype,'getParsedAccountInfo', async () => ({ value:{
    data:{ program:'spl-token', parsed:{ type:'mint', info:{
      decimals:6, supply:'1000000', mintAuthority:null, freezeAuthority:null,
    } } }
  } }));
  let builtQuote;
  let wrongUpstream = false;
  let quoteCount=0;
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    const url = new URL(raw);
    if (url.hostname === 'api.rugcheck.xyz') return Response.json({
      mint, rugged:false, score_normalised:5, totalMarketLiquidity:10000, markets:[{}],
      risks:[], topHolders:[{ pct:0.5 }],
    });
    if (url.hostname === 'api.gopluslabs.io') return Response.json({ code:1, result:{ [mint]:flags } });
    if (url.hostname === 'lite-api.jup.ag' && url.pathname.endsWith('/quote')) {
      quoteCount++;
      return Response.json({ inputMint:url.searchParams.get('inputMint'),
        outputMint:wrongUpstream ? sol : url.searchParams.get('outputMint'),
        inAmount:url.searchParams.get('amount'), outAmount:'10000', otherAmountThreshold:'9900',
        swapMode:'ExactIn', slippageBps:Number(url.searchParams.get('slippageBps')),
        priceImpactPct:'0.001', routePlan:[{}] });
    }
    if (url.hostname === 'lite-api.jup.ag' && url.pathname.endsWith('/swap')) {
      builtQuote=JSON.parse(init.body).quoteResponse;
      return Response.json({ swapTransaction:'unsigned-test-fixture',lastValidBlockHeight:123 });
    }
    throw Error('Unexpected network request: '+url.hostname);
  });
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path, body, token='test-only-local-token') => new Promise((resolve,reject) => {
    const req=http.request({ hostname:'127.0.0.1',port:server.address().port,path,method:'POST',
      headers:{ 'content-type':'application/json','x-gmgn-token':token } },res => {
      let data='';res.on('data',chunk => data+=chunk);
      res.on('end',()=>resolve({ status:res.statusCode,body:JSON.parse(data) }));
    });
    req.on('error',reject);req.end(JSON.stringify(body));
  });
  const body={ outputMint:mint,amount:0.01,slippageBps:100,userPublicKey:sol,
    portfolio:{ currentExposureSol:0,openPositions:0,isExistingMint:false },confirm:true,mode:'LIVE' };
  const route='/api/sol/swap-tx';
  assert.equal((await request(route,body,'wrong')).status,401);
  process.env.GMGN_LIVE='0';
  assert.equal((await request(route,body)).status,403);
  process.env.GMGN_LIVE='1';
  assert.equal((await request(route,{ ...body,confirm:false })).status,403);
  assert.equal((await request(route,{ ...body,amount:0.051 })).status,400);
  assert.equal((await request(route,{ ...body,slippageBps:301 })).status,400);
  assert.equal((await request(route,{ ...body,outputMint:'7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' })).status,400);
  assert.equal((await request(route,{ ...body,portfolio:{ currentExposureSol:0.095,openPositions:0,isExistingMint:false } })).status,400);
  assert.equal((await request(route,{ ...body,portfolio:{ currentExposureSol:0,openPositions:5,isExistingMint:false } })).status,400);
  assert.equal((await request(route,{ ...body,portfolio:undefined })).status,400);
  const attackerQuote={ outputMint:sol,inputMint:'wrong',outAmount:'99999',inAmount:'50000000',slippageBps:9999 };
  const result = await request(route,{ ...body, quote:attackerQuote });
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(builtQuote.inputMint,sol);
  assert.equal(builtQuote.outputMint,mint);
  assert.equal(builtQuote.inAmount,'10000000');
  assert.equal(builtQuote.slippageBps,100);
  assert.equal(quoteCount,1);
  wrongUpstream=true;
  assert.equal((await request(route,body)).status,502);
  wrongUpstream=false;
  assert.equal((await request('/api/swap',body)).status,410);
  assert.equal((await request('/api/close',body)).status,410);
  assert.equal((await request('/api/sol/close-tx',{ userPublicKey:sol,inputMint:mint,
    amountAtomic:'100',slippageBps:100,confirm:true,mode:'LIVE' })).status,200);
  assert.equal(builtQuote.inputMint,mint);
  assert.equal(builtQuote.outputMint,sol);
});

test('RPC proxy keeps broadcast behind LIVE while allowing reads and simulation', async t => {
  const oldLive = process.env.GMGN_LIVE;
  const oldToken = process.env.GMGN_LOCAL_TOKEN;
  const oldBroadcast = process.env.GMGN_SOL_BROADCAST;
  const oldLedgerPath = process.env.GMGN_TRADE_LEDGER_PATH;
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-rpc-ledger-'));
  process.env.GMGN_LIVE = '0';
  process.env.GMGN_LOCAL_TOKEN = 'rpc-test-token';
  process.env.GMGN_SOL_BROADCAST = '0';
  process.env.GMGN_TRADE_LEDGER_PATH = path.join(ledgerDir, 'ledger.json');
  t.after(() => {
    if (oldLive === undefined) delete process.env.GMGN_LIVE; else process.env.GMGN_LIVE = oldLive;
    if (oldToken === undefined) delete process.env.GMGN_LOCAL_TOKEN; else process.env.GMGN_LOCAL_TOKEN = oldToken;
    if (oldBroadcast === undefined) delete process.env.GMGN_SOL_BROADCAST; else process.env.GMGN_SOL_BROADCAST = oldBroadcast;
    if (oldLedgerPath === undefined) delete process.env.GMGN_TRADE_LEDGER_PATH; else process.env.GMGN_TRADE_LEDGER_PATH = oldLedgerPath;
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  });
  const forwarded = [];
  let failNextBroadcast = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const method = JSON.parse(init.body).method;
    forwarded.push(method);
    if (method === 'sendTransaction' && failNextBroadcast) {
      failNextBroadcast = false;
      throw new Error('fixture response lost after dispatch');
    }
    return Response.json({ jsonrpc:'2.0', id:7, result:'mock-only' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (body, token='rpc-test-token', tradeId) => new Promise((resolve, reject) => {
    const req = http.request({ hostname:'127.0.0.1', port:server.address().port,
      path:'/api/sol/rpc', method:'POST',
      headers:{ 'content-type':'application/json', 'x-gmgn-token':token,
        ...(tradeId ? { 'x-gmgn-trade-id':tradeId } : {}) } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const call = method => ({ jsonrpc:'2.0', id:7, method, params:[] });
  assert.equal(await request(call('sendTransaction'), 'wrong'), 401);
  assert.equal(await request(call('sendTransaction')), 403);
  assert.deepEqual(forwarded, []);
  assert.equal(await request([call('sendTransaction')]), 400);
  assert.equal(await request(call('sendRawTransaction')), 400);
  for (const method of ['getBalance', 'getSignatureStatuses', 'simulateTransaction']) {
    assert.equal(await request(call(method)), 200);
  }
  process.env.GMGN_LIVE = '1';
  assert.equal(await request(call('sendTransaction')), 403);
  assert.deepEqual(forwarded, ['getBalance','getSignatureStatuses','simulateTransaction']);
  process.env.GMGN_SOL_BROADCAST = '1';
  const tradeId = 'rpc-test-trade-id-1';
  const signedTx = { ...call('sendTransaction'), params:['AQ=='] };
  assert.equal(await request(signedTx, 'rpc-test-token', tradeId), 200);
  assert.equal(await request(signedTx, 'rpc-test-token', tradeId), 200);
  assert.equal(await request({ ...signedTx, params:['Ag=='] }, 'rpc-test-token', tradeId), 409);
  assert.deepEqual(forwarded, ['getBalance','getSignatureStatuses','simulateTransaction','sendTransaction']);
  const uncertainTrade = { ...signedTx, params:['Aw=='] };
  const uncertainId = 'rpc-test-uncertain-id';
  failNextBroadcast = true;
  assert.equal(await request(uncertainTrade, 'rpc-test-token', uncertainId), 502);
  assert.equal(await request(uncertainTrade, 'rpc-test-token', uncertainId), 409);
  assert.deepEqual(forwarded, [
    'getBalance','getSignatureStatuses','simulateTransaction','sendTransaction','sendTransaction',
  ]);
});
