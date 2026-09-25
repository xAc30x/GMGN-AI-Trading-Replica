interface Props {
  scanned: number;
  pending: number;
  exposure: number;
  positions: number;
  cap: number;
}

export function GateFunnel({ scanned, pending, exposure, positions, cap }: Props) {
  const stages = [
    { name: 'Scan', n: scanned, pct: 100 },
    { name: 'Safety', n: Math.max(0, scanned - 2), pct: 72 },
    { name: 'Consensus', n: Math.max(0, scanned - 3), pct: 58 },
    { name: 'ML Rank', n: Math.max(0, scanned - 4), pct: 45 },
    { name: 'LLM', n: Math.max(pending + 2, 3), pct: 35 },
    { name: 'Pending', n: pending, pct: 22 },
  ];

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>
            Gate Funnel · {scanned} in · {pending} pending
          </h2>
        </div>
        <div className="funnel">
          {stages.map((s) => (
            <div key={s.name} className="funnel-row">
              <span>{s.name}</span>
              <div className="funnel-bar">
                <span style={{ width: `${s.pct}%` }} />
              </div>
              <span>{s.n}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="side-stat">
          <div className="side-stat-row">
            <div className="top">
              <span>Open positions</span>
              <span>
                {positions}/{cap}
              </span>
            </div>
            <div className="thin-bar">
              <span style={{ width: `${(positions / cap) * 100}%` }} />
            </div>
          </div>
          <div className="side-stat-row">
            <div className="top">
              <span>Total exposure</span>
              <span>{exposure.toFixed(4)} SOL</span>
            </div>
            <div className="thin-bar orange">
              <span style={{ width: `${Math.min(100, (exposure / 2) * 100)}%` }} />
            </div>
          </div>
          <div className="side-stat-row">
            <div className="top">
              <span>Daily loss</span>
              <span>0.00 SOL</span>
            </div>
            <div className="thin-bar red">
              <span style={{ width: '2%' }} />
            </div>
          </div>
          <div className="side-stat-row">
            <div className="top">
              <span>Streak / kill</span>
              <span>3 / 0</span>
            </div>
            <div className="thin-bar">
              <span style={{ width: '40%' }} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
