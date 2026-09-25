import type { Position } from '../types';

interface Props {
  positions: Position[];
  onClose: (id: string) => void;
}

export function PositionEscapeMonitor({ positions, onClose }: Props) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Position Escape Monitor</h2>
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
            <span className={`pnl ${p.pnlPct >= 0 ? 'pos' : 'neg'}`}>
              {p.pnlPct >= 0 ? '+' : ''}
              {p.pnlPct.toFixed(1)}%
            </span>
            <button type="button" className="close-btn" onClick={() => onClose(p.id)}>
              Close
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
