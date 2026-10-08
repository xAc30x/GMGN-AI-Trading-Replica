import { useEffect, useState } from 'react';
import type { Position } from '../types';
import type { LivePnl } from '../useLivePnl';
import { formatAgo } from '../pnl';
import { SELL_PERCENTS, type SellPercent } from '../sellPercents';
import { exitAlert, type ExitAlert } from '../exitAlerts';
import { useExitAlertRules } from '../useExitAlertRules';

const STOP_CHOICES = [-5, -10, -15, -20, -30, -50];
const TARGET_CHOICES = [10, 20, 30, 50, 100, 200];

interface Props {
  positions: Position[];
  /** Sell `percent` of a holding; 100 closes it. */
  onClose: (id: string, percent: SellPercent) => void;
  livePnl?: Record<string, LivePnl>;
  refreshing?: boolean;
}

function LivePnlCell({ p, v }: { p: Position; v?: LivePnl }) {
  if (!v) return <span className="pnl">{p.sizeSol} SOL · pricing…</span>;
  if (v.noBalance) return <span className="pnl neg" title="This wallet no longer holds this token; hidden after two zero checks; history is retained">No balance · checking</span>;
  if (v.pnlPct == null || v.valueSol == null) {
    return <span className="pnl neg" title={v.error}>PnL unavailable</span>;
  }
  const sign = v.pnlPct >= 0 ? '+' : '';
  return (
    <span
      className={`pnl ${v.pnlPct >= 0 ? 'pos' : 'neg'}`}
      title={[
        `Cost ${p.sizeSol} SOL${v.tokenAmount != null ? ` · holding ${v.tokenAmount.toLocaleString()} ${p.symbol}` : ''}`,
        v.exitValueSol != null
          ? `Sell-now quote ${v.exitValueSol.toFixed(6)} SOL · price impact ${(v.priceImpactPct ?? 0).toFixed(3)}% (Jupiter, every 1s${v.exitStale ? ', last quote reused' : ''})`
          : 'No recent Jupiter quote · showing market estimate',
        v.midValueSol != null ? `Market price value ${v.midValueSol.toFixed(6)} SOL` : '',
        'Estimate versus recorded buys; external transfers or partial sales change the comparison. Excludes account rent and network fees.',
      ].filter(Boolean).join('\n')}
    >
      {sign}{v.pnlPct.toFixed(2)}% · {v.valueSol.toFixed(5)} SOL{v.exitValueSol == null ? ' · market estimate' : v.exitStale ? ' · cached quote' : ' · quote'}
    </span>
  );
}

export function PositionEscapeMonitor({ positions, onClose, livePnl = {}, refreshing }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const stamps = Object.values(livePnl).map((v) => v.updatedAt);
  const last = stamps.length ? Math.max(...stamps) : 0;
  const hasLive = positions.some((p) => !p.demo);
  const [rules, setRules] = useExitAlertRules();
  const alerts: Record<string, ExitAlert> = {};
  for (const p of positions) {
    const alert = p.demo ? null : exitAlert(livePnl[p.id], rules);
    if (alert) alerts[p.id] = alert;
  }
  const alertCount = Object.keys(alerts).length;
  // A tab title marker is visible from other tabs; valuations pause while this tab is hidden.
  useEffect(() => {
    if (!alertCount) return;
    const original = document.title;
    document.title = `(${alertCount}) Exit alert · ${original}`;
    return () => { document.title = original; };
  }, [alertCount]);

  return (
    <section className="panel" data-tour="holdings">
      <div className="panel-head">
        <h2>Tracked holdings</h2>
        {hasLive && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {last ? `valuation · ${formatAgo(now - last)}` : refreshing ? 'updating…' : 'wallet valuation'}
          </span>
        )}
      </div>
      {hasLive && (
        <div className="exit-rules" role="group" aria-label="Exit alert levels">
          <label>Stop-loss alert{' '}
            <select value={rules.stopLossPct} onChange={(e) => setRules({ ...rules, stopLossPct: Number(e.target.value) })}>
              {[...new Set([...STOP_CHOICES, rules.stopLossPct])].sort((a, b) => b - a).map((v) => <option key={v} value={v}>{v}%</option>)}
            </select>
          </label>
          <label>Profit target alert{' '}
            <select value={rules.takeProfitPct} onChange={(e) => setRules({ ...rules, takeProfitPct: Number(e.target.value) })}>
              {[...new Set([...TARGET_CHOICES, rules.takeProfitPct])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>+{v}%</option>)}
            </select>
          </label>
          <span className="meta">Alerts only, while this tab is open. Nothing sells without your wallet.</span>
        </div>
      )}
      <div className="pos-list">
        {positions.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No open positions</div>
        )}
        {positions.map((p) => (
          <div key={p.id} className={`pos-item ${p.alert || alerts[p.id] ? 'alert' : ''}`}>
            <span className="sym">
              {p.symbol}
              {p.demo ? ' · demo' : p.chain ? ` · ${p.chain}` : ''}
            </span>
            {p.demo ? (
              <span className={`pnl ${p.pnlPct >= 0 ? 'pos' : 'neg'}`}>
                {(p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(1) + '%'}
              </span>
            ) : (
              <LivePnlCell p={p} v={livePnl[p.id]} />
            )}
            <div className="sell-pcts" role="group" aria-label={`Sell ${p.symbol}`}>
              {SELL_PERCENTS.map((pct) => (
                <button key={pct} type="button" className="close-btn" aria-label={`Sell ${pct}%`}
                  title={pct === 100 ? 'Sell everything and close this holding' : `Sell ${pct}% of the tokens still held`}
                  onClick={() => onClose(p.id, pct)}>
                  {pct}%
                </button>
              ))}
            </div>
            {alerts[p.id] && (
              <div className={`exit-alert exit-alert-${alerts[p.id].kind}`} role="alert">
                <span>{p.symbol}: {alerts[p.id].text}</span>
                <button type="button" className="close-btn" onClick={() => onClose(p.id, 100)}>Sell all (wallet will ask)</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
