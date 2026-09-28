import { envNumber } from './config.js';
import { SOL_MINT, getQuote as jupiterQuote } from './jupiterSol.js';
import { discoverTokens, pricesInSol } from './discovery.js';
import { assessMint } from './mintSafety.js';
import { MIN_LIQUIDITY_USD } from './rugScanner.js';
import { recordScan } from './researchStore.js';

export function registerMarketRoutes(app, { requireLocalToken, requireLiveFlag, assertOutputToken }) {
  // Read-only mark-to-market for tracked holdings: what selling each balance to SOL would return now.
  function parsePositionValueItems(body) {
    const items = body?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 8) {
      throw Object.assign(new Error('items must be 1-8 { mint, amountAtomic } entries'), { status: 400 });
    }
    return items.map((it) => {
      const mint = assertOutputToken('sol', it?.mint);
      const raw = it?.amountAtomic;
      if (typeof raw !== 'string' || !/^\d{1,20}$/.test(raw) || BigInt(raw) <= 0n || BigInt(raw) > 18446744073709551615n) {
        throw Object.assign(new Error('amountAtomic must be a positive integer string'), { status: 400 });
      }
      return { mint, amountAtomic: raw };
    });
  }
  // Limit background quote traffic independently of wallet trade requests.
  const PNL_QUOTES_PER_MIN = envNumber('GMGN_PNL_QUOTES_PER_MIN', 40, { min: 1, max: 600, integer: true });
  function makeQuoteBudget(perMin, now = () => Date.now()) {
    const stamps = [];
    return {
      take() {
        const t = now();
        while (stamps.length && t - stamps[0] >= 60_000) stamps.shift();
        if (stamps.length >= perMin) return false;
        stamps.push(t);
        return true;
      },
    };
  }
  const pnlBudget = makeQuoteBudget(PNL_QUOTES_PER_MIN);
  const pnlQuoteCache = new Map(); // `${mint}:${amount}` -> { at, result }
  app.post('/api/sol/position-values', requireLocalToken, requireLiveFlag, async (req, res) => {
    let items;
    try {
      items = parsePositionValueItems(req.body);
    } catch (e) {
      return res.status(e.status || 400).json({ ok: false, error: e.message });
    }
    const results = await Promise.all(items.map(async ({ mint, amountAtomic }) => {
      const key = `${mint}:${amountAtomic}`;
      const cached = pnlQuoteCache.get(key);
      const hit = cached && Date.now() - cached.at <= 60_000 ? cached : null;
      if (hit && Date.now() - hit.at < Math.max(1_000, Math.ceil(60_000 * items.length / PNL_QUOTES_PER_MIN))) return { ...hit.result, stale: Date.now() - hit.at > 2_000 };
      if (!pnlBudget.take()) {
        return hit
          ? { ...hit.result, stale: true, quotedAt: hit.at }
          : { mint, amountAtomic, ok: false, error: 'PnL quote budget used up; retrying shortly' };
      }
      let result;
      try {
        const quote = await jupiterQuote({ inputMint: mint, outputMint: SOL_MINT, amountAtomic, slippageBps: 100 });
        result = { mint, amountAtomic, ok: true, outLamports: String(quote.outAmount), priceImpactPct: quote.priceImpactPct, quotedAt: Date.now() };
      } catch (e) {
        if (hit) return { ...hit.result, stale: true, quotedAt: hit.at };
        return { mint, amountAtomic, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      pnlQuoteCache.set(key, { at: Date.now(), result });
      if (pnlQuoteCache.size > 200) pnlQuoteCache.delete(pnlQuoteCache.keys().next().value);
      return result;
    }));
    res.json({ ok: true, results, budgetPerMin: PNL_QUOTES_PER_MIN, at: Date.now() });
  });

  /** Fast mid-price ticker for tracked holdings (1s UI refresh). Read-only. */
  app.get('/api/sol/prices', requireLocalToken, requireLiveFlag, async (req, res) => {
    try {
      const mints = String(req.query.mints || '').split(',').map((m) => m.trim()).filter(Boolean);
      if (mints.length === 0 || mints.length > 8) return res.status(400).json({ ok: false, error: 'mints must list 1-8 addresses' });
      for (const m of mints) assertOutputToken('sol', m);
      res.json({ ok: true, ...(await pricesInSol(mints)) });
    } catch (e) {
      res.status(e.status || 502).json({ ok: false, error: e.message });
    }
  });

  /** Discovery feed: DexScreener trending/new Solana tokens, each run through the same mint-safety gates. */
  const safetyCache = new Map(); // mint -> { at, result }
  const SAFETY_TTL_MS = 3 * 60_000;
  async function cachedSafety(mint) {
    const hit = safetyCache.get(mint);
    if (hit && Date.now() - hit.at < SAFETY_TTL_MS) return hit.result;
    let result;
    try {
      const a = await assessMint(assertOutputToken('sol', mint));
      result = {
        ok: a.ok,
        checkedAt: Date.now(),
        blockers: a.blockers || [],
        warnings: a.warnings || [],
        score: a.rug?.rugcheck?.scoreNormalised ?? null,
      };
    } catch (e) {
      result = { ok: false, checkedAt: Date.now(), blockers: [e.message || 'scan failed'], warnings: [], score: null };
    }
    safetyCache.set(mint, { at: Date.now(), result });
    if (safetyCache.size > 500) safetyCache.delete(safetyCache.keys().next().value);
    return result;
  }
  app.get('/api/sol/discover', requireLocalToken, requireLiveFlag, async (req, res) => {
    const source = req.query.source ?? 'trending';
    if (source !== 'new' && source !== 'trending') return res.status(400).json({ ok: false, error: 'source must be trending or new' });
    try {
      const tokens = await discoverTokens(source, { limit: 30, includeUnavailable: true });
      const observedAt = Date.now();
      const results = [];
      // 3 at a time to stay gentle on RugCheck/GoPlus.
      for (let i = 0; i < tokens.length; i += 3) {
        const batch = tokens.slice(i, i + 3);
        const safeties = await Promise.all(batch.map((t) => t.missingMarketData || t.liquidityUsd < MIN_LIQUIDITY_USD
          ? { ok: false, blockers: [t.missingMarketData ? 'Market data unavailable' : 'Discovery liquidity below minimum'], warnings: [], score: null }
          : cachedSafety(t.mint)));
        batch.forEach((t, j) => results.push({ ...t, safety: safeties[j] }));
      }
      const scanId = recordScan(source, results, observedAt);
      res.json({ ok: true, source, scanId, minLiquidityUsd: MIN_LIQUIDITY_USD,
        tokens: results.filter(t => !t.missingMarketData && t.liquidityUsd >= MIN_LIQUIDITY_USD).slice(0, 15), at: new Date(observedAt).toISOString() });
    } catch (e) {
      res.status(e.status || 502).json({ ok: false, error: e.message });
    }
  });


}
