import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withResearch } from '../researchStore.js';
import { createDiscoveryScanner } from '../discoveryScanner.js';
import { createPaperEngine, paperPortfolio } from '../paperTrading.js';
import { createResearchAutomation, researchSettings, updateResearchSettings, automationStatus, ensureExperiments, LEASE_MS } from '../researchAutomation.js';
import { scoreOpportunity, rankCandidates, tradeMetrics, strategyVerdict, MIN_JUDGED_TRADES, RANKED_VERSION, BASELINE_VERSION } from '../strategy.js';
import { SOL_MINT } from '../jupiterSol.js';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-automation-'));
  const prior = process.env.GMGN_RESEARCH_DB_PATH;
  process.env.GMGN_RESEARCH_DB_PATH = path.join(dir, 'research.sqlite');
  t.after(() => {
    if (prior === undefined) delete process.env.GMGN_RESEARCH_DB_PATH; else process.env.GMGN_RESEARCH_DB_PATH = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return process.env.GMGN_RESEARCH_DB_PATH;
}
const strong = { mint: 'strongMint', symbol: 'STRONG', priceUsd: 1, liquidityUsd: 100000, ageMinutes: 90,
  buys1h: 70, sells1h: 30, volume1hUsd: 12000, volume5mUsd: 2000, change1hPct: 10, change5mPct: 2,
  safety: { ok: true, blockers: [], warnings: [] } };
const weak = { ...strong, mint: 'weakMint', symbol: 'WEAK', buys1h: 40, sells1h: 60, change1hPct: -2 };
function fixture(t, options = {}) {
  temporary(t);
  let at = 1000000; let enabled = true; let scans = 0; let sell = '10000000';
  const now = () => at;
  const quote = async intent => {
    const outAmount = intent.inputMint === SOL_MINT ? '1000000' : sell;
    return { ...intent, inAmount: intent.amountAtomic, outAmount,
      otherAmountThreshold: String(BigInt(outAmount) * 99n / 100n), swapMode: 'ExactIn', priceImpactPct: '0.001', routePlan: [{}] };
  };
  const scan = createDiscoveryScanner({ now, minLiquidity: 1000,
    discover: async () => { scans++; return [weak, strong]; }, safety: async () => ({ ok: true }) });
  const params = { scan, now, enabled: () => enabled, intervalMs: 120000,
    engineOptions: { quote, priorityFee: async () => '5000', safety: async () => ({ ok: true }), sleep: async () => {}, marketCaps: async () => ({}) }, ...options };
  return { runner: createResearchAutomation(params), params, quote, now,
    advance: n => { at += n; }, enable: value => { enabled = value; }, scans: () => scans,
    sell: value => { sell = value; } };
}

test('ranking blocks unsafe, missing and extended markets and never reads future returns', () => {
  assert.equal(scoreOpportunity(strong).score, 100);
  assert.equal(scoreOpportunity(strong).action, 'candidate');
  assert.equal(scoreOpportunity({ ...strong, safety: { ok: false, blockers: ['Danger'] } }).action, 'blocked');
  assert.equal(scoreOpportunity({ ...strong, volume5mUsd: null }).score, null);
  assert.equal(scoreOpportunity({ ...strong, change5mPct: 50 }).action, 'watch');
  assert.equal(scoreOpportunity({ ...strong, liquidityUsd: 500 }).action, 'watch');
  assert.equal(scoreOpportunity({ ...strong, buys1h: NaN }).action, 'watch');
  assert.deepEqual(scoreOpportunity({ ...strong, futureReturn: 9000, outcomes: [{ returnPct: 999 }] }, 1), scoreOpportunity(strong, 1));
  const ranked = rankCandidates([weak, strong], 1);
  assert.equal(ranked[0].mint, strong.mint); assert.equal(ranked[0].feedOrder, 1);
});

test('legacy SQLite migration preserves manual cash and trades and permits independent accounts', t => {
  const file = temporary(t); const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE paper_account (id INTEGER PRIMARY KEY, initial TEXT, cash TEXT);
    INSERT INTO paper_account VALUES (1, '1000000000', '800000000');
    CREATE TABLE paper_positions (id TEXT PRIMARY KEY, mint TEXT, state TEXT, created_at INTEGER, data TEXT);
    CREATE UNIQUE INDEX paper_open_mint ON paper_positions(mint) WHERE state='open';
    CREATE TABLE paper_events (id INTEGER PRIMARY KEY, at INTEGER, position_id TEXT, kind TEXT, data TEXT);`);
  db.prepare('INSERT INTO paper_positions VALUES (?, ?, ?, ?, ?)').run('old', strong.mint, 'open', 1,
    JSON.stringify({ id: 'old', mint: strong.mint, state: 'open', mark: null }));
  db.close();
  ensureExperiments(2);
  assert.equal(paperPortfolio(2).account.cash, '800000000');
  assert.equal(paperPortfolio(2).positions[0].id, 'old');
  assert.equal(paperPortfolio(2, RANKED_VERSION).account.cash, '1000000000');
  assert.equal(paperPortfolio(2, RANKED_VERSION).positions.length, 0);
});

test('background discovery shares concurrent requests, preserves one snapshot, and reuses only recent scans', async t => {
  const f = fixture(t);
  await Promise.all([f.params.scan('trending'), f.params.scan('trending')]);
  assert.equal(f.scans(), 1);
  assert.equal(withResearch(db => db.prepare('SELECT COUNT(*) AS n FROM scans').get().n), 1);
  const first = await f.params.scan('trending');
  assert.ok(first.tokens[0].observationId); assert.equal(first.tokens[0].ranking.version, RANKED_VERSION);
  f.advance(60001);
  const second = await f.params.scan('trending');
  assert.notEqual(first.scanId, second.scanId); assert.equal(f.scans(), 2);
});

test('scheduler runs without browser requests, respects service gate, and starts with auto entries paused', async t => {
  const f = fixture(t);
  assert.deepEqual(researchSettings(), { scanning: true, autoPaper: false });
  f.enable(false); await f.runner.tick(); assert.equal(f.scans(), 0);
  f.enable(true); await f.runner.tick(); assert.equal(f.scans(), 2);
  assert.equal(automationStatus(f.now()).decisions.length, 0);
  assert.equal(paperPortfolio(f.now()).account.cash, '1000000000');
  const restarted = createResearchAutomation(f.params);
  await restarted.tick(); assert.equal(f.scans(), 2);
  f.advance(120001); await restarted.tick(); assert.equal(f.scans(), 4);
  updateResearchSettings({ scanning: false }); f.advance(120001); await restarted.tick(); assert.equal(f.scans(), 4);
});

test('automatic experiments select ranked vs feed-order baseline, isolate funds, and enforce cooldown after restart', async t => {
  const f = fixture(t); updateResearchSettings({ autoPaper: true });
  await Promise.all([f.runner.tick(), f.runner.tick(), createResearchAutomation(f.params).tick()]);
  assert.equal(f.scans(), 2);
  assert.equal(paperPortfolio(f.now(), RANKED_VERSION).positions[0].mint, strong.mint);
  assert.equal(paperPortfolio(f.now(), BASELINE_VERSION).positions[0].mint, weak.mint);
  for (const id of [RANKED_VERSION, BASELINE_VERSION]) {
    const portfolio = paperPortfolio(f.now(), id);
    assert.equal(portfolio.stats.open, 1); assert.equal(portfolio.account.cash, '987950720');
    assert.ok(portfolio.positions[0].observationId);
    assert.equal(portfolio.positions[0].selection.source, 'trending');
  }
  assert.equal(paperPortfolio(f.now()).account.cash, '1000000000');
  const autoId = paperPortfolio(f.now(), RANKED_VERSION).positions[0].id;
  await assert.rejects(createPaperEngine(f.params.engineOptions).close(autoId), /not found/);
  f.advance(120001); await createResearchAutomation(f.params).tick();
  assert.equal(paperPortfolio(f.now(), RANKED_VERSION).stats.open, 1);
  // Pausing new entries must not stop automatic exits.
  updateResearchSettings({ autoPaper: false, scanning: false }); f.sell('20000000');
  await f.runner.refreshPortfolios();
  assert.equal(paperPortfolio(f.now(), RANKED_VERSION).stats.closed, 1);
  assert.equal(paperPortfolio(f.now(), BASELINE_VERSION).stats.closed, 2);
  assert.equal(automationStatus(f.now()).accounts.find(a => a.id === RANKED_VERSION).metrics.closed, 1);
  updateResearchSettings({ autoPaper: true, scanning: true }); f.advance(120001);
  await createResearchAutomation(f.params).tick();
  // Closed coins stay excluded in both accounts for 24h; baseline may now take the other coin.
  const ranked = paperPortfolio(f.now(), RANKED_VERSION);
  assert.equal(ranked.stats.open, 0); assert.equal(ranked.stats.closed, 1);
});

test('pausing while a quote is in flight prevents the virtual fill at commit', async t => {
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  const f = fixture(t);
  const params = { ...f.params, engineOptions: { ...f.params.engineOptions, quote: async intent => { started(); await gate; return f.quote(intent); } } };
  const runner = createResearchAutomation(params);
  updateResearchSettings({ autoPaper: true });
  const running = runner.tick(); await waiting;
  updateResearchSettings({ autoPaper: false }); release(); await running;
  assert.equal(paperPortfolio(f.now(), RANKED_VERSION).stats.open, 0);
  assert.equal(paperPortfolio(f.now(), BASELINE_VERSION).stats.open, 0);
  assert.ok(automationStatus(f.now()).decisions.some(d => d.status === 'failed'));
});

test('failed feeds back off durably and leases recover after a crashed process', async t => {
  const f = fixture(t); let requests = 0;
  const params = { ...f.params, scan: async () => { requests++; throw new Error('Rate limited'); } };
  await createResearchAutomation(params).tick(); assert.equal(requests, 2);
  const job = automationStatus(f.now()).jobs[0]; assert.equal(job.failures, 1); assert.equal(job.last_error, 'Rate limited');
  f.advance(120001); await createResearchAutomation(params).tick(); assert.equal(requests, 2);
  f.advance(120001); await createResearchAutomation(params).tick(); assert.equal(requests, 4);
  withResearch(db => db.prepare("UPDATE research_jobs SET next_at=0, owner='crashed', lease_until=?").run(f.now() + LEASE_MS));
  await createResearchAutomation(f.params).tick(); assert.equal(f.scans(), 0);
  f.advance(LEASE_MS + 1); await createResearchAutomation(f.params).tick(); assert.equal(f.scans(), 2);
});

test('stale market observations never open an automatic position', async t => {
  const f = fixture(t); updateResearchSettings({ autoPaper: true });
  const scan = async source => {
    const result = await f.params.scan(source);
    return { ...result, tokens: result.tokens.map(token => ({ ...token, marketAt: f.now() - 120001 })) };
  };
  await createResearchAutomation({ ...f.params, scan }).tick();
  assert.equal(paperPortfolio(f.now(), RANKED_VERSION).stats.open, 0);
  assert.equal(paperPortfolio(f.now(), BASELINE_VERSION).stats.open, 0);
});

test('net expectancy, profit factor and sampled drawdown handle losses and missing marks honestly', () => {
  const result = tradeMetrics([
    { state: 'closed', realisedPnlLamports: '20000000' },
    { state: 'closed', realisedPnlLamports: '-10000000' },
    { state: 'open', realisedPnlLamports: '999999999' },
  ], [{ equity: '1000000000' }, { equity: '800000000' }, { equity: null }, { equity: '1010000000' }]);
  assert.equal(result.netExpectancySol, 0.005); assert.equal(result.profitFactor, 2);
  assert.equal(result.maxObservedDrawdownPct, 20); assert.equal(result.missingEquitySamples, 1);
  assert.equal(result.closed, 2); assert.equal(result.evaluation, 'Insufficient sample');
  assert.equal(tradeMetrics([], []).netExpectancySol, null);
  assert.equal(tradeMetrics([{ state: 'closed', realisedPnlLamports: '100' }], []).profitFactor, null);
});

test('win rate counts only closed trades', () => {
  const result = tradeMetrics([
    { state: 'closed', realisedPnlLamports: '5' }, { state: 'closed', realisedPnlLamports: '-5' },
    { state: 'closed', realisedPnlLamports: '0' }, { state: 'closed', realisedPnlLamports: '7' },
    { state: 'open', realisedPnlLamports: '9' },
  ], []);
  assert.equal(result.winRatePct, 50);
  assert.equal(tradeMetrics([], []).winRatePct, null);
});

test('the verdict refuses to judge small samples and never calls a loss a win', () => {
  const closed = (n, pnl) => Array.from({ length: n }, () => ({ state: 'closed', realisedPnlLamports: String(pnl) }));
  const few = strategyVerdict(tradeMetrics(closed(MIN_JUDGED_TRADES - 1, 1000000), []));
  assert.equal(few.status, 'too_few'); assert.match(few.text, /29 of 30/); assert.equal(few.beatsBaseline, null);

  const losing = strategyVerdict(tradeMetrics(closed(MIN_JUDGED_TRADES, -1000), []));
  assert.equal(losing.status, 'losing');
  const flat = strategyVerdict(tradeMetrics(closed(MIN_JUDGED_TRADES, 0), []));
  assert.equal(flat.status, 'losing', 'zero after costs is not a profit');

  const positive = strategyVerdict(tradeMetrics(closed(MIN_JUDGED_TRADES, 1000), []));
  assert.equal(positive.status, 'positive'); assert.match(positive.text, /not proof/);
  assert.equal(positive.beatsBaseline, null, 'no baseline, no comparison');
});

test('the baseline comparison needs enough trades on both sides', () => {
  const closed = (n, pnl) => Array.from({ length: n }, () => ({ state: 'closed', realisedPnlLamports: String(pnl) }));
  const ranked = tradeMetrics(closed(MIN_JUDGED_TRADES, 2000), []);
  assert.equal(strategyVerdict(ranked, tradeMetrics(closed(5, 1000), [])).beatsBaseline, null);
  assert.equal(strategyVerdict(ranked, tradeMetrics(closed(MIN_JUDGED_TRADES, 1000), [])).beatsBaseline, true);
  const worse = strategyVerdict(ranked, tradeMetrics(closed(MIN_JUDGED_TRADES, 3000), []));
  assert.equal(worse.beatsBaseline, false); assert.match(worse.text, /no better than the plain baseline/);
});

test('automation status gives each strategy a verdict and compares only the ranked one', t => {
  temporary(t);
  const status = automationStatus(1);
  const ranked = status.accounts.find(a => a.id === RANKED_VERSION);
  const baseline = status.accounts.find(a => a.id === BASELINE_VERSION);
  assert.equal(ranked.verdict.status, 'too_few'); assert.equal(baseline.verdict.status, 'too_few');
  assert.match(ranked.verdict.text, /0 of 30/);
});

test('experiment manifests are immutable and invalid settings cannot enable execution', t => {
  temporary(t); ensureExperiments(1);
  assert.throws(() => updateResearchSettings({ autoPaper: 'true' }), /booleans/);
  assert.throws(() => updateResearchSettings({ broadcast: true }), /booleans/);
  assert.equal(researchSettings().autoPaper, false);
  withResearch(db => db.prepare('UPDATE experiment_accounts SET manifest=? WHERE id=?').run('{}', RANKED_VERSION));
  assert.throws(() => ensureExperiments(2), /version bump/);
});

test('a filled position with an interrupted receipt is reconciled without replaying its signal', async t => {
  const f = fixture(t); updateResearchSettings({ autoPaper: true }); await f.runner.tick();
  withResearch(db => db.prepare("UPDATE strategy_decisions SET status='selected' WHERE status='entered'").run());
  f.advance(LEASE_MS + 1); await createResearchAutomation(f.params).tick();
  assert.equal(paperPortfolio(f.now(), RANKED_VERSION).stats.open, 1);
  assert.equal(withResearch(db => db.prepare("SELECT COUNT(*) AS n FROM strategy_decisions WHERE status='selected'").get().n), 0);
});


test('retired experiment versions keep their positions monitored and their results visible', async t => {
  const f = fixture(t); ensureExperiments(f.now());
  withResearch(db => db.prepare('INSERT INTO experiment_accounts VALUES (?, ?, ?, ?, ?)')
    .run('retired-v0', '1000000000', '1000000000', f.now(), '{}'));
  const retired = createPaperEngine({ ...f.params.engineOptions, now: f.now, accountId: 'retired-v0' });
  await retired.open({ id: 'retired-paper-001', mint: strong.mint, amount: 0.01, slippageBps: 100 });
  f.sell('20000000'); await f.runner.refreshPortfolios();
  const saved = automationStatus(f.now()).accounts.find(a => a.id === 'retired-v0');
  assert.equal(saved.currentVersion, false); assert.equal(saved.metrics.closed, 1);
  assert.equal(saved.portfolio.positions[0].exitReason, 'take_profit');
});
