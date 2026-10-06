import { useCallback, useEffect, useRef, useState } from 'react';
import { closePaperPosition, fetchPaperPortfolio, fetchScanHistory, refreshPaperPortfolio,
  type PaperPortfolioResponse, type ScanHistoryResponse } from '../api';
import { SELL_PERCENTS } from '../sellPercents';

const sol = (v: string | null | undefined) => v == null ? '—' : (Number(v) / 1e9).toFixed(6);
export function ResearchPanel({ version }: { version: number }) {
  const [portfolio, setPortfolio] = useState<PaperPortfolioResponse | null>(null);
  const [history, setHistory] = useState<ScanHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const lock = useRef(false);
  const load = useCallback(async (refresh = false) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const [p, h] = await Promise.all([refresh ? refreshPaperPortfolio() : fetchPaperPortfolio(), fetchScanHistory()]);
      setPortfolio(p); setHistory(h); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15000);
    const clockTimer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.clearInterval(clockTimer); };
  }, [load, version]);
  const close = async (id: string, percent: number) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      await closePaperPosition(id, percent);
      setPortfolio(await fetchPaperPortfolio()); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="panel research-panel">
    <div className="panel-head"><h2>Paper portfolio &amp; scan history</h2><div className="spacer" />
      <button className="btn-ghost" disabled={busy} onClick={() => void load(true)}>{busy ? 'Updating…' : 'Refresh paper marks'}</button>
    </div>
    <div className="research-content">
      <p className="help">Virtual SOL only · saved on this server · one shared research account · no wallet signature.</p>
      {error && <div className="cred-msg err" role="alert">{error}</div>}
      {portfolio && <>
        {!portfolio.monitoringEnabled && <p className="cred-msg err">Monitoring paused: the market-data service gate is disabled.</p>}
        {portfolio.workerError && <p className="cred-msg err">Monitor error: {portfolio.workerError}</p>}
        <div className="research-stats">
          <span>Cash <strong>{sol(portfolio.account.cash)} SOL</strong></span>
          <span>Equity <strong>{sol(clock - portfolio.at <= 45000 ? portfolio.stats.equityLamports : null)} SOL</strong></span>
          <span>Realized P&amp;L <strong>{sol(portfolio.stats.realisedPnlLamports)} SOL</strong></span>
          <span>Closed <strong>{portfolio.stats.closed}</strong></span><span>Wins <strong>{portfolio.stats.wins}</strong></span>
        </div>
        <p className="help">Starting cash {sol(portfolio.account.initial)} SOL. Assumptions: {portfolio.model.latencyMs / 1000}s delay,
          quote minimum output on both sides, {sol(portfolio.model.feeLamports)} SOL fee per side,
          {` ${sol(portfolio.model.entryRentLamports)}`} SOL entry rent (no refund modeled).
          Sell buttons sell that share of the tokens still held; each sale pays the fee. Automatic full exits: stop {portfolio.model.stopLossPct}%, target +{portfolio.model.takeProfitPct}%, time {portfolio.model.maxHoldMs / 60000}m.
          Stops are checked about every 15s while the backend runs; fills can pass the threshold. These defaults are unvalidated.</p>
        <div className="table-wrap"><table className="screen"><thead><tr><th>Token</th><th>Status</th><th>Cost held</th><th>Net P&amp;L</th><th>Exit / action</th></tr></thead>
          <tbody>{portfolio.positions.length === 0 && <tr><td colSpan={5}>No paper positions. Select a coin in PAPER to start tracking.</td></tr>}
            {portfolio.positions.map(p => {
              const fresh = p.mark && !p.lastError && clock - p.mark.at <= 45000;
              return <tr key={p.id}><td title={p.mint}>{p.symbol}<div className="meta">{new Date(p.openedAt).toLocaleString()}</div></td>
                <td>{p.state}{p.exitPending && <div className="meta">Exit pending: {p.exitPending}</div>}{p.lastError && <div className="safe-bad">{p.lastError}</div>}</td>
                <td>{sol(p.costLamports)} SOL{p.partialExits?.length ? <div className="meta">after {p.partialExits.length} partial sell{p.partialExits.length > 1 ? 's' : ''}</div> : null}</td>
                <td>{p.state === 'closed' ? `${sol(p.realisedPnlLamports)} SOL`
                  : fresh ? `${p.mark!.pnlPct.toFixed(2)}%` : 'Awaiting fresh quote'}
                  {p.state === 'open' && p.realisedPnlLamports != null && <div className="meta">Realized so far {sol(p.realisedPnlLamports)} SOL</div>}</td>
                <td>{p.state === 'closed' ? p.exitReason : <div className="sell-pcts" role="group" aria-label={`Sell paper ${p.symbol}`}>
                  {SELL_PERCENTS.map(pct => <button key={pct} type="button" className="btn-ghost" disabled={busy || !portfolio.monitoringEnabled || (pct < 100 && Boolean(p.exitPending))}
                    aria-label={`Sell ${pct}%`} title={pct === 100 ? 'Close the whole paper position' : `Sell ${pct}% of the tokens still held`}
                    onClick={() => void close(p.id, pct)}>{pct}%</button>)}
                </div>}</td></tr>;
            })}</tbody></table></div>
        <p className="help">Equity is unavailable when any open position lacks a fresh executable quote. Provider failures do not close positions or charge simulated execution fees.</p>
      </>}
      {history && <details><summary>Scan history · {history.totals.observations} observations · {history.totals.eligible ?? 0} eligible · {history.totals.blocked ?? 0} blocked</summary>
        <p className="help">Latest 30 observations, including rejected candidates. Returns are USD market-price changes, before costs; they are not paper-trade returns.
          Missing prices stay unknown; observation windows missed during downtime are labeled missed.</p>
        <div className="table-wrap"><table className="screen"><thead><tr><th>Observed</th><th>Token / feed</th><th>Screen</th><th>5m</th><th>1h</th><th>24h</th></tr></thead>
          <tbody>{history.rows.map(r => <tr key={r.id}><td>{new Date(r.at).toLocaleString()}</td><td title={r.mint}>{r.symbol || r.mint.slice(0, 8)}<div className="meta">{r.source === 'trending' ? 'Top boosted' : r.source === 'watchlist' ? 'Watchlist' : 'Latest profiles'}</div></td>
            <td title={r.safety.blockers.join('\n')}>{r.decision}</td>{r.outcomes.map(o => <td key={o.horizon} title={o.error || undefined}>{o.returnPct == null ? o.status : `${o.returnPct.toFixed(2)}%`}</td>)}</tr>)}</tbody>
        </table></div>
      </details>}
    </div>
  </section>;
}
