import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withResearch, recordScan, scanHistory, collectOutcomes, HORIZONS, OUTCOME_GRACE_MS } from '../researchStore.js';
import { createPaperEngine, paperPortfolio, PAPER_MODEL } from '../paperTrading.js';
import { SOL_MINT } from '../jupiterSol.js';

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
    safety: async () => ({ ok: !blocked, blockers: blocked ? ['Unsafe mint'] : [] }),
    quote: async intent => {
      calls.push({ ...intent, at });
      if (broken) throw new Error('No sell route');
      const outAmount = intent.inputMint === SOL_MINT ? '1000000' : sell;
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
