import type { LogEntry } from '../types';

interface Props {
  logs: LogEntry[];
}

export function DecisionLog({ logs }: Props) {
  return (
    <section className="panel log-panel">
      <div className="panel-head">
        <h2>📈 Live Decision Log · trade_decisions.jsonl</h2>
      </div>
      <div className="log-list">
        {[...logs].reverse().map((l) => (
          <div key={l.id} className="log-row">
            <span>{l.ts}</span>
            <span className={`kind ${l.kind}`}>{l.kind}</span>
            <span>
              <span className="cat">[{l.category}] </span>
              {l.message}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
