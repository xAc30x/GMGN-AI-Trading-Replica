import { liveTradeRecord, syncLiveTrades } from './liveTrades.js';

/** Read-only: the live trade record. Each read first looks up any sent trades not yet recorded. */
export function registerLiveTradeRoutes(app, { requireLocalToken, connection }) {
  app.get('/api/live/trades', requireLocalToken, async (req, res) => {
    const wallet = req.query.wallet == null ? undefined : String(req.query.wallet);
    if (wallet !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      return res.status(400).json({ ok: false, error: 'wallet must be a base58 address' });
    }
    try {
      const sync = await syncLiveTrades({ connection });
      res.json({ ok: true, ...liveTradeRecord({ wallet }), sync });
    } catch (e) {
      res.status(e.status || 503).json({ ok: false, error: e.message });
    }
  });
}
