import { useEffect, useState } from 'react';
import type { Position } from '../types';
import type { LivePnl } from '../useLivePnl';
import { formatAgo } from '../pnl';

interface Props {
  positions: Position[];
  onClose: (id: string) => void;
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

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Tracked holdings</h2>
        {hasLive && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {last ? `valuation · ${formatAgo(now - last)}` : refreshing ? 'updating…' : 'wallet valuation'}
          </span>
        )}
      </div>
      <div className="pos-list">
        {positions.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No open positions</div>
        )}
        {positions.map((p) => (
          <div key={p.id} className={`pos-item ${p.alert ? 'alert' : ''}`}>
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
            <button type="button" className="close-btn" onClick={() => onClose(p.id)}>
              Close
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
