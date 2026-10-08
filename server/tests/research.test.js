import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withResearch, recordScan, scanHistory, collectOutcomes, HORIZONS, OUTCOME_GRACE_MS } from '../researchStore.js';
import { createPaperEngine, paperPortfolio, PAPER_MODEL } from '../paperTrading.js';
import { SOL_MINT, jupiterPriorityFee, MAX_PRIORITY_FEE_LAMPORTS } from '../jupiterSol.js';

const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-research-'));
  const old = process.env.GMGN_RESEARCH_DB_PATH;
  process.env.GMGN_RESEARCH_DB_PATH = path.join(dir, 'research.sqlite');
  t.after(() => {
    if (old === undefined) delete process.env.GMGN_RESEARCH_DB_PATH; else process.env.GMGN_RESEARCH_DB_PATH = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return process.env.GMGN_RESEARCH_DB_PATH;
}
function fixture(t, options = {}) {
  setup(t);
  let at = 1000000;
  let sell = '50000000';
  let broken = false;
  let blocked = false;
  const calls = [];
  const engineOptions = {
    now: () => at, sleep: async ms => { at += ms; },
    // 5000 signature fee + 5000 priority fee keeps the per-side fee at 10000 lamports.
    priorityFee: async () => '5000',
    safety: async () => ({ ok: !blocked, blockers: blocked ? ['Unsafe mint'] : [] }),
    quote: async intent => {
      calls.push({ ...intent, at });
      if (broken) throw new Error('No sell route');
      // `scaled` makes sell quotes proportional to the amount sold (for partial-sell checks).
      const outAmount = intent.inputMint === SOL_MINT ? '1000000'
        : options.scaled ? String(BigInt(intent.amountAtomic) * 50n) : sell;
      return { ...intent, inAmount: intent.amountAtomic, outAmount,
        otherAmountThreshold: String(BigInt(outAmount) * BigInt(10000 - intent.slippageBps) / 10000n),
        swapMode: 'ExactIn', priceImpactPct: '0.001', routePlan: [{}] };
    }, ...options,
  };
  return { engine: createPaperEngine(engineOptions), engineOptions, calls,
    time: () => at, advance: ms => { at += ms; }, price: value => { sell = value; },
    broken: value => { broken = value; }, blocked: value => { blocked = value; } };
}
const entry = { id: 'paper-request-0001', mint, symbol: 'TEST', amount: 0.05, slippageBps: 100 };

test('scan history persists blocked and eligible snapshots and labels unknown / missed outcomes', async t => {
  setup(t); const at = 1000000;
  recordScan('new', [
    { mint, symbol: 'A', priceUsd: 2, safety: { ok: true, blockers: [] } },
    { mint: 'blocked', priceUsd: 4, safety: { ok: false, blockers: ['Concentrated'] } },
    { mint: 'missing', priceUsd: null, safety: { ok: false, blockers: ['No market data'] } },
  ], at);
  let h = scanHistory();
  assert.equal(h.totals.observations, 3); assert.equal(h.totals.blocked, 2);
  const firstPage = scanHistory(1).rows;
  const nextPage = scanHistory(2, firstPage[0].at, firstPage[0].id).rows;
  assert.equal(new Set([...firstPage, ...nextPage].map(r => r.id)).size, 3);
  await collectOutcomes(async () => ({ [mint]: 3, blocked: 2 }), () => at + HORIZONS[0]);
  h = scanHistory();
  assert.equal(h.rows.find(r => r.mint === mint).outcomes[0].returnPct, 50);
  assert.equal(h.rows.find(r => r.mint === 'blocked').outcomes[0].returnPct, -50);
  assert.equal(h.rows.find(r => r.mint === 'missing').outcomes[0].status, 'unavailable');
  await collectOutcomes(async () => { throw new Error('offline'); }, () => at + HORIZONS[1]);
  assert.equal(scanHistory().rows.find(r => r.mint === mint).outcomes[1].status, 'pending');
  await collectOutcomes(async () => ({ [mint]: 99 }), () => at + HORIZONS[1] + OUTCOME_GRACE_MS + 1);
  const missed = scanHistory().rows.find(r => r.mint === mint).outcomes[1];
  assert.equal(missed.status, 'missed'); assert.equal(missed.returnPct, null);
});

test('paper accounting persists across engine recreation; quotes are delayed, costs exact and retries idempotent', async t => {
  const f = fixture(t);
  const before = f.time();
  const opened = await f.engine.open(entry);
  assert.equal(f.calls[0].at, before + PAPER_MODEL.latencyMs);
  assert.equal(opened.quantityAtomic, '990000');
  assert.equal(opened.costLamports, '52049280');
  assert.equal(paperPortfolio(f.time()).account.cash, '947950720');
  const restarted = createPaperEngine(f.engineOptions);
  await restarted.open(entry);
  assert.equal(f.calls.length, 1);
  await assert.rejects(restarted.open({ ...entry, amount: 0.04 }), /reused/);
  assert.equal(paperPortfolio(f.time()).stats.equityLamports, null);
  await restarted.refresh();
  assert.equal(paperPortfolio(f.time()).stats.equityLamports, '997440720');
  f.advance(45001);
  assert.equal(paperPortfolio(f.time()).stats.equityLamports, null);
  const closed = await restarted.close(entry.id);
  assert.equal(closed.proceedsLamports, '49490000');
  assert.equal(closed.realisedPnlLamports, '-2559280');
  await restarted.close(entry.id);
  assert.equal(paperPortfolio(f.time()).account.cash, '997440720');
  assert.equal(paperPortfolio(f.time()).stats.closed, 1);
  assert.equal(paperPortfolio(f.time()).stats.realisedPnlLamports, '-2559280');
});

test('paper trades pay the live-style priority fee on entry and exit; marks estimate it from the entry', async t => {
  const fees = [];
  const f = fixture(t, { priorityFee: async q => {
    const fee = q.inputMint === SOL_MINT ? '200000' : '300000';
    fees.push(fee); return fee;
  } });
  const opened = await f.engine.open(entry);
  assert.equal(opened.model.version, 'quote-min-output-v2');
  assert.equal(opened.entryPriorityFeeLamports, '200000');
  assert.equal(opened.costLamports, String(50000000 + 5000 + 200000 + 2039280));
  await f.engine.refresh();
  const marked = paperPortfolio(f.time()).positions[0];
  assert.equal(marked.mark.netLamports, String(49500000 - 5000 - 200000));
  assert.deepEqual(fees, ['200000'], 'marks do not ask Jupiter for a fee');
  const closed = await f.engine.close(entry.id);
  assert.equal(closed.exitFeeLamports, '305000');
  assert.equal(closed.proceedsLamports, String(49500000 - 305000));
  assert.equal(closed.realisedPnlLamports, String(49500000 - 305000 - 52244280));
  assert.equal(paperPortfolio(f.time()).account.cash, String(1000000000 - 52244280 + 49195000));
});

test('a partial sell records the priority fee it paid', async t => {
  const f = fixture(t, { scaled: true, priorityFee: async q => q.inputMint === SOL_MINT ? '5000' : '45000' });
  await f.engine.open(entry);
  const part = await f.engine.sell(entry.id, 50);
  assert.equal(part.partialExits[0].feeLamports, '50000');
});

test('positions opened under the fixed-fee v1 model keep that fee and never ask Jupiter', async t => {
  const v1 = { ...PAPER_MODEL, version: 'quote-min-output-v1', feeLamports: '10000' };
  delete v1.baseFeeLamports; delete v1.priorityFee;
  const f = fixture(t, { model: v1, priorityFee: async () => { throw new Error('v1 must not fetch a fee'); } });
  const opened = await f.engine.open(entry);
  assert.equal(opened.costLamports, '52049280');
  // A later engine on the new model still exits the old position with its own fee.
  const current = createPaperEngine({ ...f.engineOptions, model: PAPER_MODEL });
  const closed = await current.close(entry.id);
  assert.equal(closed.proceedsLamports, '49490000');
});

test('a missing priority fee blocks the entry and retries the exit instead of guessing', async t => {
  let feeDown = true;
  const f = fixture(t, { priorityFee: async () => { if (feeDown) throw new Error('Jupiter returned no usable priority fee'); return '5000'; } });
  await assert.rejects(f.engine.open(entry), /no usable priority fee/);
  assert.equal(paperPortfolio(f.time()).account.cash, '1000000000');
  assert.equal(paperPortfolio(f.time()).positions.length, 0);
  feeDown = false;
  await f.engine.open(entry);
  feeDown = true;
  await assert.rejects(f.engine.close(entry.id), /no usable priority fee/);
  const stuck = paperPortfolio(f.time()).positions[0];
  assert.equal(stuck.state, 'open'); assert.equal(stuck.exitPending, 'manual');
  feeDown = false;
  await f.engine.refresh();
  assert.equal(paperPortfolio(f.time()).positions[0].state, 'closed');
});

test('jupiterPriorityFee reads the fee from a throwaway swap build and refuses unusable values', async () => {
  const seen = [];
  const swapWith = value => async request => { seen.push(request); return { prioritizationFeeLamports: value }; };
  assert.equal(await jupiterPriorityFee({ q: 1 }, { swap: swapWith(123456), referenceKey: () => 'ref' }), '123456');
  assert.deepEqual(seen[0], { quoteResponse: { q: 1 }, userPublicKey: 'ref' });
  assert.equal(await jupiterPriorityFee({}, { swap: swapWith(0) }), '0');
  for (const bad of [undefined, null, '5000', -1, 1.5, Number(MAX_PRIORITY_FEE_LAMPORTS) + 1]) {
    await assert.rejects(jupiterPriorityFee({}, { swap: swapWith(bad) }), /no usable priority fee/);
  }
  // The default reference key is a fresh, valid public key; no secret is kept.
  await jupiterPriorityFee({}, { swap: swapWith(1) });
  assert.match(seen.at(-1).userPublicKey, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test('safety failures and invalid fills cannot debit virtual cash', async t => {
  const f = fixture(t);
  f.blocked(true);
  await assert.rejects(f.engine.open(entry), /Unsafe mint/);
  assert.equal(f.calls.length, 0);
  f.blocked(false); f.broken(true);
  await assert.rejects(f.engine.open(entry), /No sell route/);
  assert.equal(paperPortfolio().account.cash, '1000000000');
  const wrong = createPaperEngine({ ...f.engineOptions, quote: async () => ({}) });
  await assert.rejects(wrong.open(entry), /does not match/);
  assert.equal(paperPortfolio().stats.open, 0);
});

test('concurrent duplicate requests and cross-engine closes do not double-debit or credit', async t => {
  const f = fixture(t);
  const second = createPaperEngine(f.engineOptions);
  await Promise.all([f.engine.open(entry), second.open(entry)]);
  assert.equal(paperPortfolio().account.cash, '947950720');
  await assert.rejects(f.engine.open({ ...entry, id: 'different-request-02' }), /already open/);
  await Promise.all([f.engine.close(entry.id), second.close(entry.id)]);
  assert.equal(paperPortfolio().account.cash, '997440720');
});

for (const [reason, price, advance] of [['stop_loss', '10000000', 0], ['take_profit', '100000000', 0], ['time_exit', '50000000', 3600001]]) {
  test(`automatic ${reason} uses a new exit quote and records net realised P&L`, async t => {
    const f = fixture(t);
    await f.engine.open(entry); f.price(price); f.advance(advance);
    await f.engine.refresh();
    const p = paperPortfolio(f.time()).positions[0];
    assert.equal(p.state, 'closed'); assert.equal(p.exitReason, reason);
    assert.equal(f.calls.length, 3); // entry, mark, then a delayed executable exit
    assert.equal(f.calls[2].amountAtomic, '990000');
    assert.equal(f.calls[2].at - f.calls[1].at, PAPER_MODEL.latencyMs);
  });
}

test('failed exits remain pending across restart; unavailable marks cannot report fresh equity', async t => {
  const f = fixture(t); await f.engine.open(entry);
  await f.engine.refresh(); f.broken(true);
  await assert.rejects(f.engine.close(entry.id), /No sell route/);
  let p = paperPortfolio(f.time());
  assert.equal(p.stats.open, 1); assert.equal(p.stats.equityLamports, null);
  assert.equal(p.positions[0].exitPending, 'manual');
  assert.equal(p.account.cash, '947950720');
  f.broken(false);
  await createPaperEngine(f.engineOptions).refresh();
  p = paperPortfolio(f.time());
  assert.equal(p.stats.closed, 1); assert.equal(p.positions[0].exitReason, 'manual');
});

test('insufficient cash and position caps are checked atomically at fill time', async t => {
  const f = fixture(t);
  withResearch(db => db.prepare("UPDATE paper_account SET cash='1000' WHERE id=1").run());
  await assert.rejects(f.engine.open(entry), /Insufficient virtual/);
  assert.equal(paperPortfolio().stats.open, 0);
  withResearch(db => db.prepare("UPDATE paper_account SET cash='1000000000' WHERE id=1").run());
  for (let i = 0; i < 5; i++) await f.engine.open({ ...entry, id: `paper-request-${i + 100}`, mint: `mint${i}` });
  await assert.rejects(f.engine.open(entry), /5 open positions/);
  assert.equal(paperPortfolio().stats.open, 5);
});

test('partial sell keeps the position open with proportional size, cost and realised P&L', async t => {
  const f = fixture(t, { scaled: true });
  await f.engine.open(entry);
  await f.engine.refresh();
  const part = await f.engine.sell(entry.id, 25);
  assert.equal(part.state, 'open');
  assert.equal(part.quantityAtomic, '742500');
  assert.equal(part.costLamports, '39036960');
  assert.equal(part.proceedsLamports, '12241250');
  assert.equal(part.realisedPnlLamports, '-771070');
  assert.equal(part.mark, null);
  assert.deepEqual(part.partialExits.map(x => [x.percent, x.quantityAtomic]), [[25, '247500']]);
  let p = paperPortfolio(f.time());
  assert.equal(p.account.cash, '960191970');
  assert.equal(p.stats.open, 1); assert.equal(p.stats.closed, 0);
  assert.equal(p.stats.realisedPnlLamports, '-771070');
  assert.equal(p.stats.equityLamports, null);
  assert.equal(p.events[0].kind, 'partial_exit');

  const closed = await f.engine.sell(entry.id, 100);
  assert.equal(closed.state, 'closed'); assert.equal(closed.exitReason, 'manual');
  assert.equal(f.calls.at(-1).amountAtomic, '742500');
  assert.equal(closed.proceedsLamports, '48985000');
  // Same as one full sale (-3054280) minus the second modeled fee.
  assert.equal(closed.realisedPnlLamports, '-3064280');
  p = paperPortfolio(f.time());
  assert.equal(p.account.cash, '996935720');
  assert.equal(p.stats.realisedPnlLamports, '-3064280');
  assert.equal(p.stats.wins, 0);
});

test('100% sell is exactly the existing close; invalid percents change nothing', async t => {
  const f = fixture(t);
  await f.engine.open(entry);
  for (const bad of [0, 101, 12.5, -10, Number.NaN]) {
    await assert.rejects(f.engine.sell(entry.id, bad), /whole number from 1 to 100/);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(paperPortfolio().account.cash, '947950720');
  const closed = await f.engine.sell(entry.id, 100);
  assert.equal(closed.proceedsLamports, '49490000');
  assert.equal(closed.realisedPnlLamports, '-2559280');
  await assert.rejects(f.engine.sell(entry.id, 25), /already closed/);
  assert.equal(paperPortfolio().account.cash, '997440720');
});

test('stop / target checks after a partial sell value only the remaining tokens', async t => {
  const f = fixture(t, { scaled: true });
  await f.engine.open(entry);
  await f.engine.sell(entry.id, 75);
  await f.engine.refresh();
  assert.equal(f.calls.at(-1).amountAtomic, '247500');
  const p = paperPortfolio(f.time()).positions[0];
  assert.equal(p.state, 'open');
  assert.equal(p.mark.netLamports, '12241250');
});

test('partial sells cannot race a pending exit or each other', async t => {
  const f = fixture(t, { scaled: true });
  await f.engine.open(entry);
  const second = createPaperEngine(f.engineOptions);
  const results = await Promise.allSettled([f.engine.sell(entry.id, 25), second.sell(entry.id, 10)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /changed while the sale/);
  assert.equal(paperPortfolio().positions[0].partialExits.length, 1);
  assert.equal(paperPortfolio().events.filter(e => e.kind === 'partial_exit').length, 1);

  f.broken(true);
  await assert.rejects(f.engine.close(entry.id), /No sell route/);
  f.broken(false);
  await assert.rejects(f.engine.sell(entry.id, 25), /full exit is already pending/);
});

test('a partial sell that overlaps a full exit is rejected; the exit credits the whole position once', async t => {
  const f = fixture(t, { scaled: true });
  await f.engine.open(entry);
  const second = createPaperEngine(f.engineOptions);
  const [part, full] = await Promise.allSettled([f.engine.sell(entry.id, 25), second.close(entry.id)]);
  assert.match(part.reason.message, /changed while the sale/);
  assert.equal(full.status, 'fulfilled');
  const p = paperPortfolio(f.time());
  assert.equal(p.positions[0].state, 'closed');
  assert.equal(p.positions[0].partialExits, undefined);
  assert.equal(p.positions[0].realisedPnlLamports, '-3054280');
  assert.equal(p.account.cash, '996945720');
});
