import { createHash, randomUUID } from 'node:crypto';
import { envNumber } from './config.js';
import { withResearch, transaction } from './researchStore.js';
import { createPaperEngine, paperPortfolio, PAPER_MODEL } from './paperTrading.js';
import { RANKED_VERSION, EXPERIMENT_VERSIONS, EXPERIMENT_POLICY, RANKING_RULES, tradeMetrics } from './strategy.js';

export const SCAN_INTERVAL_MS = envNumber('GMGN_RESEARCH_SCAN_SECONDS', 120, { min: 60, max: 3600, integer: true }) * 1000;
export const LEASE_MS = 300000;
const readSettings = db => {
  const row = db.prepare('SELECT * FROM research_settings WHERE id=1').get();
  return { scanning: Boolean(row.scanning), autoPaper: Boolean(row.auto_paper) };
};
export const researchSettings = () => withResearch(readSettings);
export function updateResearchSettings(patch) {
  if (!patch || typeof patch !== 'object' || !Object.keys(patch).length ||
    Object.entries(patch).some(([key, value]) => !['scanning', 'autoPaper'].includes(key) || typeof value !== 'boolean')) {
    throw Object.assign(new Error('Settings accept only scanning and autoPaper booleans'), { status: 400 });
  }
  return withResearch(db => transaction(db, () => {
    const settings = { ...readSettings(db), ...patch };
    db.prepare('UPDATE research_settings SET scanning=?, auto_paper=? WHERE id=1').run(Number(settings.scanning), Number(settings.autoPaper));
    return settings;
  }));
}

export function ensureExperiments(at = Date.now()) {
  withResearch(db => transaction(db, () => {
    for (const id of EXPERIMENT_VERSIONS) {
      const manifest = JSON.stringify({ id, policy: EXPERIMENT_POLICY, model: PAPER_MODEL,
        rules: id === RANKED_VERSION ? RANKING_RULES : 'First safety-passing token in original feed order; positive price/liquidity',
        evaluation: 'Prospective fixed rules; no historical outcome access' });
      db.prepare('INSERT OR IGNORE INTO experiment_accounts VALUES (?, ?, ?, ?, ?)').run(id, '1000000000', '1000000000', at, manifest);
      if (db.prepare('SELECT manifest FROM experiment_accounts WHERE id=?').get(id).manifest !== manifest) {
        throw new Error(`Experiment definition changed without a version bump: ${id}`);
      }
    }
  }));
}

export function automationStatus(now = Date.now()) {
  ensureExperiments(now);
  const saved = withResearch(db => ({
    settings: readSettings(db),
    jobs: db.prepare('SELECT * FROM research_jobs ORDER BY source').all(),
    decisions: db.prepare('SELECT * FROM strategy_decisions ORDER BY at DESC, id DESC LIMIT 30').all().map(r => ({ ...r, data: JSON.parse(r.data) })),
    accounts: db.prepare('SELECT id, started_at FROM experiment_accounts ORDER BY started_at, id').all().map(account => ({
      id: account.id, startedAt: account.started_at,
      positions: db.prepare('SELECT data FROM paper_positions WHERE account_id=?').all(account.id).map(r => JSON.parse(r.data)),
      equity: db.prepare('SELECT equity FROM experiment_equity WHERE account_id=? ORDER BY at, id').all(account.id),
      decisionCounts: db.prepare('SELECT status, COUNT(*) AS count FROM strategy_decisions WHERE account_id=? GROUP BY status').all(account.id),
    })),
  }));
  return { ...saved, intervalMs: SCAN_INTERVAL_MS, policy: EXPERIMENT_POLICY, at: now,
    accounts: saved.accounts.map(a => ({ id: a.id, currentVersion: EXPERIMENT_VERSIONS.includes(a.id), startedAt: a.startedAt, decisionCounts: a.decisionCounts,
      portfolio: paperPortfolio(now, a.id), metrics: tradeMetrics(a.positions, a.equity) })),
  };
}

export function createResearchAutomation({ scan, enabled, maxAmount, now = () => Date.now(),
  engineOptions = {}, intervalMs = SCAN_INTERVAL_MS } = {}) {
  const owner = randomUUID();
  const autoAllowed = (db, selection) => {
    const settings = readSettings(db);
    const job = selection && db.prepare('SELECT owner, lease_until FROM research_jobs WHERE source=?').get(selection.source);
    return enabled() && settings.scanning && settings.autoPaper && job?.owner === owner && job.lease_until > now()
      && now() >= selection.marketAt && now() - selection.marketAt <= EXPERIMENT_POLICY.maxSignalAgeMs;
  };
  const engines = Object.fromEntries(EXPERIMENT_VERSIONS.map(accountId => [accountId, createPaperEngine({
    ...engineOptions, maxAmount, now, accountId, maxPositions: EXPERIMENT_POLICY.maxPositions,
    cooldownMs: EXPERIMENT_POLICY.cooldownMs, canOpen: autoAllowed,
  })]));
  let pending = null;
  function claim(source) {
    return withResearch(db => transaction(db, () => {
      if (!enabled() || !readSettings(db).scanning) return false;
      db.prepare('INSERT OR IGNORE INTO research_jobs (source) VALUES (?)').run(source);
      return db.prepare('UPDATE research_jobs SET owner=?, lease_until=? WHERE source=? AND next_at<=? AND lease_until<=?')
        .run(owner, now() + LEASE_MS, source, now(), now()).changes === 1;
    }));
  }
  async function enter(accountId, result) {
    const id = 'auto_' + createHash('sha256').update(accountId + ':' + result.scanId).digest('hex');
    const selection = withResearch(db => transaction(db, () => {
      const settings = readSettings(db);
      if (!enabled() || !settings.scanning || !settings.autoPaper) return null;
      const positions = db.prepare('SELECT mint, state, created_at FROM paper_positions WHERE account_id=?').all(accountId);
      const candidates = accountId === RANKED_VERSION
        ? result.tokens.filter(t => t.ranking?.version === RANKED_VERSION && t.ranking.action === 'candidate')
        : [...result.tokens].sort((a, b) => a.feedOrder - b.feedOrder).filter(t => t.safety.ok && t.priceUsd > 0 && t.liquidityUsd > 0);
      const fresh = candidates.filter(t => Number.isFinite(t.marketAt) && now() >= t.marketAt && now() - t.marketAt <= EXPERIMENT_POLICY.maxSignalAgeMs);
      const token = fresh.find(t => !positions.some(p => p.mint === t.mint && (p.state === 'open' || p.created_at > now() - EXPERIMENT_POLICY.cooldownMs)));
      const full = positions.filter(p => p.state === 'open').length >= EXPERIMENT_POLICY.maxPositions;
      const reason = full ? 'Position cap reached' : !token ? 'No fresh candidate outside the coin cooldown' : null;
      const data = { source: result.source, marketAt: token?.marketAt ?? null, observationId: token?.observationId ?? null,
        ranking: token?.ranking ?? null, reason, selectionReason: accountId === RANKED_VERSION
          ? 'Highest qualifying score outside the coin cooldown' : 'First eligible token in original feed order outside the coin cooldown', amountSol: EXPERIMENT_POLICY.amountSol };
      const inserted = db.prepare('INSERT OR IGNORE INTO strategy_decisions VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, accountId, result.scanId, now(), token?.mint ?? null, reason ? 'skipped' : 'selected', JSON.stringify(data));
      if (!inserted.changes || reason) return null;
      return { token, data };
    }));
    if (!selection) return;
    let status = 'entered'; let error = null;
    try {
      await engines[accountId].open({ id, mint: selection.token.mint, symbol: selection.token.symbol,
        amount: EXPERIMENT_POLICY.amountSol, slippageBps: EXPERIMENT_POLICY.slippageBps,
        observationId: selection.data.observationId, selection: selection.data });
    } catch (e) { status = 'failed'; error = e.message; }
    withResearch(db => db.prepare('UPDATE strategy_decisions SET status=?, data=? WHERE id=?')
      .run(status, JSON.stringify({ ...selection.data, error }), id));
  }
  async function run() {
    if (!enabled() || !researchSettings().scanning) return;
    ensureExperiments(now());
    // A crash between fill and receipt must not erase the filled trade or replay an old signal.
    withResearch(db => db.prepare(`UPDATE strategy_decisions SET status=CASE WHEN EXISTS
      (SELECT 1 FROM paper_positions p WHERE p.id=strategy_decisions.id) THEN 'entered' ELSE 'interrupted' END
      WHERE status='selected' AND at<?`).run(now() - LEASE_MS));
    for (const source of ['trending', 'new']) {
      if (!claim(source)) continue;
      try {
        const result = await scan(source);
        // Separate accounts, concurrent evaluations: neither gets priority over the other's cash or quote time.
        await Promise.all(EXPERIMENT_VERSIONS.map(id => enter(id, result)));
        withResearch(db => db.prepare(`UPDATE research_jobs SET next_at=?, lease_until=0, owner=NULL, failures=0,
          last_at=?, last_scan_id=?, last_error=NULL WHERE source=? AND owner=?`)
          .run(now() + intervalMs, now(), result.scanId, source, owner));
      } catch (e) {
        withResearch(db => {
          const job = db.prepare('SELECT failures FROM research_jobs WHERE source=? AND owner=?').get(source, owner);
          if (!job) return;
          const failures = job.failures + 1;
          const delay = Math.min(1800000, intervalMs * 2 ** Math.min(failures, 8));
          db.prepare('UPDATE research_jobs SET next_at=?, lease_until=0, owner=NULL, failures=?, last_at=?, last_error=? WHERE source=? AND owner=?')
            .run(now() + delay, failures, now(), e.message, source, owner);
        });
      }
    }
  }
  function tick() {
    if (!pending) pending = run().finally(() => { pending = null; });
    return pending;
  }
  async function refreshPortfolios() {
    ensureExperiments(now());
    const accountIds = withResearch(db => db.prepare('SELECT id FROM experiment_accounts').all().map(a => a.id));
    await Promise.all(accountIds.map(async id => {
      // Version changes retire new entries, not the existing positions or their evidence.
      engines[id] ||= createPaperEngine({ ...engineOptions, maxAmount, now, accountId: id, canOpen: () => false });
      const portfolio = await engines[id].refresh();
      withResearch(db => db.prepare('INSERT INTO experiment_equity (account_id, at, equity) VALUES (?, ?, ?)')
        .run(id, now(), portfolio.stats.equityLamports));
    }));
  }
  return { tick, refreshPortfolios };
}
