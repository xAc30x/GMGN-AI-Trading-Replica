import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection } from '@solana/web3.js';
import { solanaAddresses, summarizePairs, usdPricesFromPairs } from '../discovery.js';

const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const sol = 'So11111111111111111111111111111111111111112';
const pair = { chainId: 'solana', baseToken: { address: mint, symbol: 'TEST' }, liquidity: { usd: 10000 }, priceUsd: '2' };

test('discovery uses unique Solana base assets, deepest liquidity and valid numeric data', () => {
  assert.deepEqual(solanaAddresses([
    { chainId: 'solana', tokenAddress: mint }, { chainId: 'solana', tokenAddress: mint },
    { chainId: 'ethereum', tokenAddress: mint }, { chainId: 'solana', tokenAddress: sol },
  ]), [mint]);
  const rows = summarizePairs([{ ...pair, priceUsd: '99', liquidity: { usd: 1 } }, pair,
    { ...pair, chainId: 'ethereum', liquidity: { usd: 99999 } }], [mint]);
  assert.equal(rows[0].priceUsd, 2);
  assert.equal(rows[0].change1hPct, null);
  assert.equal(rows[0].url, `https://dexscreener.com/solana/${mint}`);
  assert.deepEqual(usdPricesFromPairs([{ ...pair, priceUsd: 'Infinity' }], [mint]), {});
});

test('market routes enforce auth/service gate, bound requests, screen discoveries and expire cached quotes', async t => {
  const before = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-market-'));
  process.env.GMGN_RESEARCH_DB_PATH = path.join(dir, 'research.sqlite');
  process.env.GMGN_LOCAL_TOKEN = 'market-test-token';
  process.env.GMGN_LIVE = '0';
  process.env.GMGN_PNL_QUOTES_PER_MIN = '1';
  const { app } = await import('../index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of ['GMGN_LOCAL_TOKEN', 'GMGN_LIVE', 'GMGN_PNL_QUOTES_PER_MIN', 'GMGN_RESEARCH_DB_PATH']) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let quoteCalls = 0;
  let quoteFails = false;
  t.mock.method(Connection.prototype, 'getParsedAccountInfo', async () => ({ value: {
    data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6, supply: '1000000', mintAuthority: null, freezeAuthority: null } } },
  } }));
  t.mock.method(globalThis, 'fetch', async raw => {
    const url = new URL(raw);
    if (url.hostname === 'api.dexscreener.com') {
      if (url.pathname.includes('/tokens/')) return Response.json([pair, { ...pair, baseToken: { address: sol }, priceUsd: '100' }]);
      return Response.json([{ chainId: 'solana', tokenAddress: mint }]);
    }
    // Unavailable screening providers must leave discovery entries blocked.
    if (url.hostname === 'api.rugcheck.xyz' || url.hostname === 'api.gopluslabs.io') return new Response('', { status: 503 });
    if (url.hostname === 'lite-api.jup.ag' && url.pathname.endsWith('/quote')) {
      quoteCalls++;
      if (quoteFails) return new Response('', { status: 503 });
      return Response.json({ inputMint: mint, outputMint: sol, inAmount: url.searchParams.get('amount'),
        outAmount: '20000000', otherAmountThreshold: '19800000', swapMode: 'ExactIn', slippageBps: 100,
        priceImpactPct: '0.001', routePlan: [{}] });
    }
    throw new Error('Unexpected external request: ' + url.hostname);
  });
  const request = (path, body, token = 'market-test-token') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path,
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-gmgn-token': token } }, res => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const items = [{ mint, amountAtomic: '1000' }];
  for (const [path, body] of [['/api/sol/discover', undefined], [`/api/sol/prices?mints=${mint}`, undefined], ['/api/sol/position-values', { items }]]) {
    assert.equal((await request(path, body, 'wrong')).status, 401);
    assert.equal((await request(path, body)).status, 403);
  }
  process.env.GMGN_LIVE = '1';
  assert.equal((await request('/api/sol/discover?source=invalid')).status, 400);
  assert.equal((await request('/api/sol/position-values', { items: Array(9).fill(items[0]) })).status, 400);
  assert.equal((await request('/api/sol/position-values', { items: [{ mint, amountAtomic: '-1' }] })).status, 400);
  const discovery = await request('/api/sol/discover?source=trending');
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.tokens.length, 1);
  assert.equal(discovery.body.tokens[0].safety.ok, false);
  assert.ok(discovery.body.scanId);
  assert.equal((await request('/api/research/scans', undefined, 'wrong')).status, 401);
  assert.equal((await request('/api/research/scans')).body.totals.blocked, 1);
  assert.equal((await request('/api/paper/portfolio', undefined, 'wrong')).status, 401);
  assert.equal((await request('/api/paper/portfolio')).body.account.cash, '1000000000');
  assert.equal((await request('/api/research/scans?limit=999')).status, 400);
  process.env.GMGN_LIVE = '0';
  for (const route of ['open', 'close', 'refresh']) {
    assert.equal((await request('/api/paper/' + route, {})).status, 403);
  }
  assert.equal((await request('/api/paper/portfolio')).status, 200);
  process.env.GMGN_LIVE = '1';
  assert.equal((await request('/api/paper/open', { id: 'paper-request-0001', mint, amount: 0.01 })).status, 400);
  assert.equal((await request('/api/paper/portfolio')).body.stats.open, 0);
  const watch = await request('/api/sol/watchlist-scan', { mints: [mint] });
  assert.equal(watch.status, 200);
  assert.ok(watch.body.scanId);
  const saved = (await request('/api/research/scans')).body;
  assert.equal(saved.totals.observations, 2);
  assert.ok(saved.rows.some(row => row.source === 'watchlist'));
  assert.equal((await request(`/api/sol/prices?mints=${mint}`)).body.prices[mint], 0.02);
  const first = await request('/api/sol/position-values', { items });
  assert.equal(first.body.results[0].outLamports, '20000000');
  now += 3000;
  const cached = await request('/api/sol/position-values', { items });
  assert.equal(cached.body.results[0].stale, true);
  assert.equal(cached.body.results[0].quotedAt, first.body.results[0].quotedAt);
  assert.equal(quoteCalls, 1);
  const changedBalance = await request('/api/sol/position-values', { items: [{ mint, amountAtomic: '2000' }] });
  assert.equal(changedBalance.body.results[0].ok, false);
  now += 61000; quoteFails = true;
  assert.equal((await request('/api/sol/position-values', { items })).body.results[0].ok, false);
});
