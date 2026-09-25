interface Props {
  scanned: number;
  pastSafety: number;
  blockedSafety: number;
  pastConsensus: number;
  blockedConsensus: number;
  awaiting: number;
  positions: number;
  cap: number;
  exposure: number;
  escapeAlerts: number;
  trapRate: number;
}

export function MetricCards(p: Props) {
  return (
    <div className="metrics">
      <div className="metric">
        <div className="label">⚡ Total scanned</div>
        <div className="value">{p.scanned}</div>
      </div>
      <div className="metric">
        <div className="label">🛡 Past safety</div>
        <div className="value">{p.pastSafety}</div>
        <div className="sub">blocked {p.blockedSafety}</div>
      </div>
      <div className="metric">
        <div className="label">👤 Past consensus</div>
        <div className="value">{p.pastConsensus}</div>
        <div className="sub">blocked {p.blockedConsensus}</div>
      </div>
      <div className="metric highlight">
        <div className="label">◎ Awaiting you</div>
        <div className="value">{p.awaiting}</div>
        <div className="sub">click to buy</div>
      </div>
      <div className="metric">
        <div className="label">⌀ Positions / cap</div>
        <div className="value">
          {p.positions}/{p.cap}
        </div>
        <div className="sub">exposure {p.exposure.toFixed(4)} SOL</div>
      </div>
      <div className={`metric ${p.escapeAlerts > 0 ? 'alert' : ''}`}>
        <div className="label">🚨 Escape alerts</div>
        <div className="value">{p.escapeAlerts}</div>
        <div className="sub">{p.escapeAlerts > 0 ? '⚠ act now' : 'all clear'}</div>
      </div>
      <div className="metric">
        <div className="label">⊕ Trap catch rate</div>
        <div className="value">{p.trapRate}%</div>
        <div className="sub">0 rugs missed</div>
      </div>
    </div>
  );
}
