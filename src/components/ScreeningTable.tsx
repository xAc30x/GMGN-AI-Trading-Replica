import type { ScreenToken, TradeMode } from '../types';

interface Props {
  tokens: ScreenToken[];
  buyAmount: number;
  onBuyAmount: (n: number) => void;
  onBuy: (t: ScreenToken) => void;
  onOpenSettings: () => void;
  scanning?: boolean;
  mode?: TradeMode;
}

const RULE_MARK: Record<string, string> = {
  pass: '✓',
  warn: '!',
  fail: '✗',
  neutral: '·',
};

export function ScreeningTable({
  tokens,
  buyAmount,
  onBuyAmount,
  onBuy,
  onOpenSettings,
  scanning,
  mode = 'SHADOW',
}: Props) {
  return (
    <section className={`panel ${scanning ? 'scanning' : ''}`} style={{ position: 'relative' }}>
      {(mode === 'LIVE' || mode === 'PAPER') && (
        <div className="mock-data-banner">
          This screening table is still <strong>mock demo data</strong>. It does not come from
          RugCheck/GoPlus. Real safety runs only when you paste a mint in the buy modal.
        </div>
      )}
      <div className="panel-head">
        <h2>Screening Results · Awaiting Your Call</h2>
        <div className="spacer" />
        <div className="buy-amount-ctrl">
          BUY
          <input
            type="number"
            min={0.001}
            step={0.01}
            value={buyAmount}
            onChange={(e) => onBuyAmount(Number(e.target.value) || 0)}
            aria-label="Buy amount SOL"
          />
          SOL
        </div>
        <button type="button" className="icon-btn" onClick={onOpenSettings} title="Settings">
          ⚙
        </button>
      </div>

      <div className="table-wrap">
        <table className="screen">
          <thead>
            <tr>
              <th>Token</th>
              <th>Rule→Rank→LLM</th>
              <th>Safe</th>
              <th>Bund</th>
              <th>Dev</th>
              <th>T10</th>
              <th>Smart/KOL</th>
              <th>Dev Score</th>
              <th>Timing</th>
              <th>LLM</th>
              <th>Priority</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>
                  <div className="token-cell">
                    <span className="sym">{t.symbol}</span>
                    <span className="meta">
                      {t.mintShort} · {t.age}
                    </span>
                  </div>
                </td>
                <td>
                  <div className="rule-row">
                    {t.ruleIcons.map((r, i) => (
                      <span key={i} className={`rule-dot ${r}`} title={r}>
                        {RULE_MARK[r]}
                      </span>
                    ))}
                  </div>
                </td>
                <td className={t.safeOk ? 'safe-ok' : 'safe-bad'}>{t.safe}</td>
                <td>{t.bund}%</td>
                <td>{t.dev}%</td>
                <td>{t.t10}%</td>
                <td>
                  {t.smart}/{t.kol}
                </td>
                <td>
                  <span className={`dev-score ${t.devLabel}`}>
                    {t.devLabel} {t.devScore}
                  </span>
                </td>
                <td>{t.timing}</td>
                <td>
                  <span className={`llm-pill ${t.llm}`}>{t.llm}</span>
                </td>
                <td>
                  <span className="priority">{t.priority} priority</span>
                </td>
                <td>
                  {t.decision === 'buy' ? (
                    <button type="button" className="buy-btn" onClick={() => onBuy(t)}>
                      ⚡ BUY {buyAmount} SOL
                    </button>
                  ) : t.decision === 'watch' ? (
                    <button type="button" className="watch-btn" disabled>
                      HOLD
                    </button>
                  ) : (
                    <span className="blocked-btn">BLOCKED</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
