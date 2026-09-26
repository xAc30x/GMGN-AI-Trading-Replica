import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envNumber } from '../config.js';
import { assertPriceImpactOk, assertQuoteMatches, solToLamports, clampSlippageBps } from '../jupiterSol.js';
import { scanRug } from '../rugScanner.js';

const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const intent = { inputMint: 'SOL', outputMint: mint, amountAtomic: '10000', slippageBps: 100 };
const quote = { inputMint: 'SOL', outputMint: mint, inAmount: '10000', outAmount: '10000',
  otherAmountThreshold: '9900', slippageBps: 100, swapMode: 'ExactIn',
  priceImpactPct: '0.01', routePlan: [{}] };
const rug = { mint, rugged: false, score_normalised: 10, risks: [], topHolders: [{ pct: 0.5 }],
  totalMarketLiquidity: 10000, markets: [{}] };
const clear = Object.fromEntries(['non_transferable','closable','transfer_hook','freezable','mintable']
  .map(k => [k, { status: '0' }]));
const go = { code: 1, result: { [mint]: clear } };

test('quote binds both mints, exact amount, slippage and mode', () => {
  assert.doesNotThrow(() => assertQuoteMatches(quote, intent));
  for (const change of [{ inputMint:'other' }, { outputMint:'other' }, { inAmount:'9000' },
    { slippageBps:300 }, { swapMode:'ExactOut' }, { otherAmountThreshold:'1' },
    { otherAmountThreshold:'10001' }, { routePlan:[] }, { outAmount:'NaN' },
    { inAmount:10000 }, { priceImpactPct:undefined }]) {
    assert.throws(() => assertQuoteMatches({ ...quote, ...change }, intent));
  }
});
test('impact uses fractions consistently and fails closed', () => {
  for (const v of ['0','0.01','0.05']) assert.doesNotThrow(() => assertPriceImpactOk({ priceImpactPct:v }));
  for (const v of ['0.051','1','1.01','12',undefined,'NaN','',null,0.01]) {
    assert.throws(() => assertPriceImpactOk({ priceImpactPct:v }));
  }
});
test('invalid slippage and excess decimal precision are rejected', () => {
  for (const v of [0,-1,1.5,'junk',Infinity]) assert.throws(() => clampSlippageBps(v));
  assert.throws(() => solToLamports('0.0000000001'));
});
test('invalid numeric configuration cannot disable limits', () => {
  const key = 'GMGN_TEST_LIMIT';
  try {
    for (const v of ['NaN','Infinity','-1','1.5']) {
      process.env[key] = v;
      assert.throws(() => envNumber(key, 3, { min:0, integer:true }));
    }
    process.env[key]='0'; assert.equal(envNumber(key, 3), 0);
  } finally { delete process.env[key]; }
});
async function scan(t, r, g, target = mint) {
  t.mock.method(globalThis, 'fetch', async url => {
    const data = String(url).includes('rugcheck') ? r : g;
    if (data instanceof Error) throw data;
    return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status:200 });
  });
  return scanRug(target);
}
test('valid low holder percentage is not multiplied by 100', async t => {
  const result = await scan(t, rug, go);
  assert.equal(result.ok, true);
});
test('empty HTTP200 scanner results fail closed', async t => {
  assert.equal((await scan(t, {}, {})).ok, false);
});
test('malformed JSON and provider error responses fail closed', async t => {
  assert.equal((await scan(t, 'not json', { code:500, result:{} })).ok, false);
});
test('zero, missing and invalid liquidity block even with valid GoPlus', async t => {
  for (const liq of [0, undefined, null, -1, '10000', 999]) {
    const result = await scan(t, { ...rug, totalMarketLiquidity:liq }, go);
    assert.equal(result.ok, false);
    t.mock.restoreAll();
  }
});
test('wrong-mint and malformed GoPlus entries are not reused', async t => {
  for (const data of [{ code:1, result:{ other:clear } }, { code:1, result:{ [mint]:{} } }]) {
    const result = await scan(t, new Error('offline'), data);
    assert.equal(result.ok, false);
    assert.ok(result.providerErrors.some(e => e.includes('GoPlus')));
    t.mock.restoreAll();
  }
});
test('valid RugCheck tolerates GoPlus outage under existing policy', async t => {
  assert.equal((await scan(t, rug, new Error('offline'))).ok, true);
});
test('danger flags still block', async t => {
  assert.equal((await scan(t, rug, { code:1, result:{ [mint]:{ ...clear, freezable:{ status:'1' } } } })).ok, false);
});
test('existing stable allowlist exception remains', async t => {
  assert.equal((await scan(t, new Error('offline'), new Error('offline'),
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).ok, true);
});

test('unknown or empty risk severity cannot be classified safe', async t => {
  for (const level of ['', 'unknown']) {
    const result = await scan(t, { ...rug, risks:[{ name:'risk',level }] }, new Error('offline'));
    assert.equal(result.ok,false);
    t.mock.restoreAll();
  }
});
test('severity normalization preserves danger blocks', async t => {
  const result = await scan(t, { ...rug, risks:[{ name:'risk',level:' Danger ' }] }, go);
  assert.equal(result.ok,false);
});
