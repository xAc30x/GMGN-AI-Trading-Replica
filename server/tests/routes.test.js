import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import { createSignedInSession } from './authSession.js';
import { authorizeBroadcast } from '../tradeLedger.js';
import { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
let app;

const session = await createSignedInSession();
after(() => session.cleanup());

const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const sol = 'So11111111111111111111111111111111111111112';
const flags = Object.fromEntries(['non_transferable','closable','transfer_hook','freezable','mintable']
  .map(k => [k,{ status:'0' }]));

test('route invariants: auth, LIVE gate, cap, denylist, fresh quote, closes', async t => {
  const oldLive = process.env.GMGN_LIVE;
  const oldToken = process.env.GMGN_LOCAL_TOKEN;
  const oldTradePath = process.env.GMGN_TRADE_LEDGER_PATH;
  const oldPortfolioPath = process.env.GMGN_PORTFOLIO_LEDGER_PATH;
  const oldRpcUrl = process.env.SOLANA_RPC_URL;
  const portfolioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-portfolio-route-'));
  const rpcFixture = http.createServer(async (req, res) => {
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const rpc=JSON.parse(Buffer.concat(chunks).toString());
    let result;
    if (rpc.method === 'getTokenAccountsByOwner') {
      const filter=rpc.params[1];
      result={ context:{ slot:1 },value:filter.mint === mint ? [{
        pubkey:sol,
        account:{ executable:false,lamports:1,owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',rentEpoch:0,space:165,
          data:{ program:'spl-token',space:165,parsed:{ type:'account',info:{
            mint,owner:sol,tokenAmount:{ amount:'1000',decimals:6,uiAmount:0.001,uiAmountString:'0.001' },
          } } } },
      }] : [] };
    } else if (rpc.method === 'getSlot' || rpc.method === 'getBlockHeight') result=1;
    else if (rpc.method === 'getSignatureStatuses') result={ context:{ slot:1 },value:[null] };
    else result=null;
    res.writeHead(200,{ 'content-type':'application/json' });
    res.end(JSON.stringify({ jsonrpc:'2.0',id:rpc.id,result }));
  });
  await new Promise(resolve => rpcFixture.listen(0,'127.0.0.1',resolve));
  process.env.GMGN_LIVE='1';
  process.env.GMGN_LOCAL_TOKEN='test-only-local-token';
  process.env.GMGN_TRADE_LEDGER_PATH=path.join(portfolioDir, 'trades.json');
  process.env.GMGN_PORTFOLIO_LEDGER_PATH=path.join(portfolioDir, 'portfolio.sqlite');
  process.env.SOLANA_RPC_URL=`http://127.0.0.1:${rpcFixture.address().port}`;
  t.after(async () => {
    if (oldLive === undefined) delete process.env.GMGN_LIVE; else process.env.GMGN_LIVE=oldLive;
    if (oldToken === undefined) delete process.env.GMGN_LOCAL_TOKEN; else process.env.GMGN_LOCAL_TOKEN=oldToken;
    if (oldTradePath === undefined) delete process.env.GMGN_TRADE_LEDGER_PATH; else process.env.GMGN_TRADE_LEDGER_PATH=oldTradePath;
    if (oldPortfolioPath === undefined) delete process.env.GMGN_PORTFOLIO_LEDGER_PATH; else process.env.GMGN_PORTFOLIO_LEDGER_PATH=oldPortfolioPath;
    if (oldRpcUrl === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL=oldRpcUrl;
    fs.rmSync(portfolioDir,{ recursive:true,force:true });
    await new Promise(resolve => rpcFixture.close(resolve));
  });
  ({ app } = await import('../index.js'));
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
      const tx = new VersionedTransaction(new TransactionMessage({
        payerKey: new PublicKey(JSON.parse(init.body).userPublicKey),
        recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [],
      }).compileToV0Message());
      return Response.json({ swapTransaction:Buffer.from(tx.serialize()).toString('base64'),lastValidBlockHeight:123 });
    }
    throw Error('Unexpected network request: '+url.hostname);
  });
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path, body, token='test-only-local-token') => new Promise((resolve,reject) => {
    const req=http.request({ hostname:'127.0.0.1',port:server.address().port,path,method:'POST',
      headers:{ 'content-type':'application/json','x-gmgn-token':token,cookie:session.cookie } },res => {
      let data='';res.on('data',chunk => data+=chunk);
      res.on('end',()=>resolve({ status:res.statusCode,body:JSON.parse(data) }));
    });
    req.on('error',reject);req.end(JSON.stringify(body));
  });
  let nextTradeId=0;
  const body={ outputMint:mint,amount:0.01,slippageBps:100,userPublicKey:sol,
    tradeId:'controlled-route-trade-0001',
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
  const buildWithNewId = (overrides) => request(route,{
    ...body,tradeId:`controlled-route-trade-${String(++nextTradeId).padStart(4,'0')}`,...overrides,
  });
  const forgedEmpty = await buildWithNewId({portfolio:{ currentExposureSol:0.095,openPositions:0,isExistingMint:false }});
  assert.equal(forgedEmpty.status,200,JSON.stringify(forgedEmpty.body));
  assert.equal((await buildWithNewId({portfolio:{ currentExposureSol:0,openPositions:5,isExistingMint:false }})).status,200);
  assert.equal((await buildWithNewId({portfolio:undefined})).status,200);
  const attackerQuote={ outputMint:sol,inputMint:'wrong',outAmount:'99999',inAmount:'50000000',slippageBps:9999 };
  const result = await buildWithNewId({quote:attackerQuote});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(builtQuote.inputMint,sol);
  assert.equal(builtQuote.outputMint,mint);
  assert.equal(builtQuote.inAmount,'10000000');
  assert.equal(builtQuote.slippageBps,100);
  assert.equal(quoteCount,4);
  wrongUpstream=true;
  assert.equal((await buildWithNewId({})).status,502);
  wrongUpstream=false;
  assert.equal((await request('/api/swap',body)).status,410);
  assert.equal((await request('/api/close',body)).status,410);
  assert.equal((await request('/api/sol/close-tx',{ tradeId:'controlled-close-trade-0001',userPublicKey:sol,inputMint:mint,
    amountAtomic:'100',slippageBps:100,confirm:true,mode:'LIVE' })).status,200);
  assert.equal(builtQuote.inputMint,mint);
  assert.equal(builtQuote.outputMint,sol);
  assert.equal((await request('/api/sol/close-tx',{ tradeId:'controlled-close-trade-0001',userPublicKey:sol,inputMint:mint,
    amountAtomic:'1001',slippageBps:100,confirm:true,mode:'LIVE' })).status,400);
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
  const oldRpc = process.env.SOLANA_RPC_URL;
  const rpc = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.method, 'getBlockHeight');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 1 }));
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  process.env.SOLANA_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
  t.after(async () => {
    await new Promise(resolve => rpc.close(resolve));
    if (oldRpc === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = oldRpc;
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
    const payload = JSON.parse(init.body);
    const signature = method === 'sendTransaction'
      ? bs58.encode(VersionedTransaction.deserialize(Buffer.from(payload.params[0], 'base64')).signatures[0]) : 'mock-only';
    return Response.json({ jsonrpc:'2.0', id:7, result:signature });
  });
  const { app: rpcApp } = await import('../index.js?rpc-gate-fixture');
  const server = rpcApp.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (body, token='rpc-test-token', tradeId) => new Promise((resolve, reject) => {
    const req = http.request({ hostname:'127.0.0.1', port:server.address().port,
      path:'/api/sol/rpc', method:'POST',
      headers:{ 'content-type':'application/json', 'x-gmgn-token':token, cookie:session.cookie,
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
  const signingWallet=Keypair.generate();
  const signedPayload=(authorizedId) => {
    const transaction=new VersionedTransaction(new TransactionMessage({
      payerKey:signingWallet.publicKey,
      recentBlockhash:Keypair.generate().publicKey.toBase58(),
      instructions:[],
    }).compileToV0Message());
    if (authorizedId) authorizeBroadcast({ tradeId: authorizedId,
      swapTransaction: Buffer.from(transaction.serialize()).toString('base64'),
      walletAddress: signingWallet.publicKey.toBase58(), side:'close',mode:'LIVE',lastValidBlockHeight:123,
      intent: { inputMint: mint, outputMint: sol, inAmount: '100' },
    });
    transaction.sign([signingWallet]);
    return Buffer.from(transaction.serialize()).toString('base64');
  };
  const signedTx = { ...call('sendTransaction'), params:[signedPayload(tradeId)] };
  assert.equal(await request(signedTx, 'rpc-test-token', tradeId), 200);
  assert.equal(await request(signedTx, 'rpc-test-token', tradeId), 200);
  assert.equal(await request({ ...signedTx, params:[signedPayload()] }, 'rpc-test-token', tradeId), 409);
  assert.deepEqual(forwarded, ['getBalance','getSignatureStatuses','simulateTransaction','sendTransaction']);
  const uncertainId = 'rpc-test-uncertain-id';
  const uncertainTrade = { ...signedTx, params:[signedPayload(uncertainId)] };
  failNextBroadcast = true;
  assert.equal(await request(uncertainTrade, 'rpc-test-token', uncertainId), 502);
  assert.equal(await request(uncertainTrade, 'rpc-test-token', uncertainId), 409);
  assert.deepEqual(forwarded, [
    'getBalance','getSignatureStatuses','simulateTransaction','sendTransaction','sendTransaction',
  ]);
});
