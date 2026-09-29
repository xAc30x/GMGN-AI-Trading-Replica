import { scanHistory, collectOutcomes } from './researchStore.js';
import { createPaperEngine, paperPortfolio } from './paperTrading.js';
import { marketPricesUsd } from './discovery.js';
import { createResearchAutomation, automationStatus, updateResearchSettings } from './researchAutomation.js';

export function registerResearchRoutes(app, { requireLocalToken, requireLiveFlag, assertOutputToken, maxAmount, enabled, scanDiscovery }) {
  const engine = createPaperEngine({ maxAmount });
  const automation = createResearchAutomation({ scan: scanDiscovery, enabled, maxAmount });
  let schedulerError = null;
  let running = null;
  let lastRun = 0;
  let workerError = null;
  async function refresh() {
    if (running) return running;
    if (Date.now() - lastRun < 15000) return;
    running = (async () => {
      try {
        const results = await Promise.allSettled([engine.refresh(), automation.refreshPortfolios(), collectOutcomes(marketPricesUsd)]);
        workerError = results.filter(r => r.status === 'rejected').map(r => r.reason.message).join('; ') || null;
      } catch (e) { workerError = e.message; }
      finally { lastRun = Date.now(); running = null; }
    })();
    return running;
  }
  const route = fn => async (req, res) => {
    try { res.json({ ok: true, ...await fn(req) }); }
    catch (e) { res.status(e.status || 503).json({ ok: false, error: e.message }); }
  };
  app.get('/api/research/scans', requireLocalToken, route(req => {
    const limit = Number(req.query.limit ?? 50);
    const before = Number(req.query.before ?? Number.MAX_SAFE_INTEGER);
    const beforeId = req.query.beforeId ?? '~';
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1 || typeof beforeId !== 'string' || !/^[A-Za-z0-9_~-]{1,128}$/.test(beforeId)) {
      throw Object.assign(new Error('Invalid history pagination'), { status: 400 });
    }
    return scanHistory(limit, before, beforeId);
  }));
  app.get('/api/paper/portfolio', requireLocalToken, route(() => ({ ...paperPortfolio(), workerError, monitoringEnabled: enabled() })));
  app.post('/api/paper/open', requireLocalToken, requireLiveFlag, route(async req => {
    const mint = assertOutputToken('sol', req.body?.mint);
    const { id, symbol, amount, slippageBps } = req.body;
    return { position: await engine.open({ id, symbol, amount, slippageBps, mint }) };
  }));
  app.post('/api/paper/close', requireLocalToken, requireLiveFlag, route(async req => {
    if (typeof req.body?.id !== 'string') throw Object.assign(new Error('Paper position id required'), { status: 400 });
    return { position: await engine.close(req.body.id) };
  }));
  app.post('/api/paper/refresh', requireLocalToken, requireLiveFlag, route(async () => {
    await refresh();
    return { ...paperPortfolio(), workerError, monitoringEnabled: enabled() };
  }));
  app.get('/api/research/automation', requireLocalToken, route(() => ({
    ...automationStatus(), serviceEnabled: enabled(), schedulerError, monitorError: workerError,
  })));
  // Pause remains available even when the market-data service is disabled.
  app.post('/api/research/automation', requireLocalToken, route(req => ({
    settings: updateResearchSettings(req.body), serviceEnabled: enabled(),
  })));
  // Separate loops: discovery backoff or slow screening cannot stop paper exits.
  return function startResearchMonitor() {
    const tick = () => {
      if (!enabled()) return;
      void refresh();
      void automation.tick().then(() => { schedulerError = null; }).catch(e => { schedulerError = e.message; });
    };
    const timer = setInterval(tick, 15000);
    timer.unref(); tick();
    return () => clearInterval(timer);
  };
}
