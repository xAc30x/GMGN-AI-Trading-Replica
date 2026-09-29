import { discoverTokens } from './discovery.js';
import { assessMint } from './mintSafety.js';
import { MIN_LIQUIDITY_USD } from './rugScanner.js';
import { recordScan, withResearch } from './researchStore.js';
import { rankCandidates } from './strategy.js';

// UI and scheduler share in-flight scans and a short result cache.
export function createDiscoveryScanner({ assertMint, discover = discoverTokens, safety = assessMint,
  now = () => Date.now(), minLiquidity = MIN_LIQUIDITY_USD } = {}) {
  const pending = new Map(); const cached = new Map(); const safetyCache = new Map();
  async function check(mint) {
    const old = safetyCache.get(mint);
    if (old && now() - old.checkedAt < 180000) return old;
    let result;
    try {
      const a = await safety(assertMint ? assertMint(mint) : mint);
      result = { ok: a.ok, checkedAt: now(), blockers: a.blockers || [], warnings: a.warnings || [], score: a.rug?.rugcheck?.scoreNormalised ?? null };
    } catch (e) { result = { ok: false, checkedAt: now(), blockers: [e.message], warnings: [], score: null }; }
    safetyCache.set(mint, result);
    if (safetyCache.size > 500) safetyCache.delete(safetyCache.keys().next().value);
    return result;
  }
  async function scan(source) {
    if (!['trending', 'new'].includes(source)) throw Object.assign(new Error('Invalid discovery source'), { status: 400 });
    if (pending.has(source)) return pending.get(source);
    const old = cached.get(source);
    if (old && now() - old.completedAt < 60000) return old;
    const work = (async () => {
      const tokens = await discover(source, { limit: 30, includeUnavailable: true });
      const marketAt = now();
      const results = [];
      for (let i = 0; i < tokens.length; i += 3) {
        const batch = tokens.slice(i, i + 3);
        const safeties = await Promise.all(batch.map(t => t.missingMarketData || t.liquidityUsd < minLiquidity
          ? { ok: false, checkedAt: now(), blockers: [t.missingMarketData ? 'Market data unavailable' : 'Discovery liquidity below minimum'], warnings: [], score: null }
          : check(t.mint)));
        batch.forEach((t, j) => results.push({ ...t, marketAt, safety: safeties[j] }));
      }
      const completedAt = now();
      const ranked = rankCandidates(results, completedAt);
      const scanId = recordScan(source, ranked, completedAt);
      const observations = withResearch(db => db.prepare('SELECT id, mint FROM observations WHERE scan_id=?').all(scanId));
      const result = { scanId, source, completedAt, at: new Date(completedAt).toISOString(), minLiquidityUsd: minLiquidity,
        tokens: ranked.map(t => ({ ...t, observationId: observations.find(o => o.mint === t.mint)?.id })) };
      cached.set(source, result);
      return result;
    })().finally(() => pending.delete(source));
    pending.set(source, work);
    return work;
  }
  return scan;
}
