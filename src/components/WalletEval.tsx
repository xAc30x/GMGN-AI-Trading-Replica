import { useState } from 'react';
import { DEMO_WALLET, WALLET_EVAL } from '../data/mockData';
import type { WalletEvalData } from '../types';
import { CopyTradeBacktest } from './CopyTradeBacktest';

function scoreColor(n: number): string {
  if (n >= 60) return 'var(--lime)';
  if (n >= 35) return 'var(--orange)';
  if (n > 0) return '#e87a40';
  return 'var(--text-dim)';
}

function barTone(n: number): string {
  if (n >= 60) return 'var(--lime)';
  if (n >= 35) return 'var(--orange)';
  if (n > 0) return 'var(--red)';
  return 'var(--border-soft)';
}

type FactorTab = 'track' | 'copy' | 'dev';

export function WalletEval() {
  const [address, setAddress] = useState(DEMO_WALLET);
  const [data, setData] = useState<WalletEvalData | null>(WALLET_EVAL);
  const [factorTab, setFactorTab] = useState<FactorTab>('copy');

  const analyze = () => {
    setData({
      ...WALLET_EVAL,
      address,
      addressShort:
        address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address,
    });
  };

  const factors =
    factorTab === 'track'
      ? data?.trackFactors
      : factorTab === 'copy'
        ? data?.copyFactors
        : data?.devFactors;

  const totalCoins = data?.pnlBuckets.reduce((s, b) => s + b.count, 0) ?? 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="mock-data-banner">Demo wallet analytics and illustrative calculator — no wallet history is fetched.</div>
      <div className="wallet-search">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Wallet address"
          aria-label="Wallet address"
          spellCheck={false}
        />
        <button type="button" className="btn-primary" onClick={analyze}>
          Evaluate
        </button>
      </div>

      {data && (
        <>
          <section className="wallet-card">
            <div className="wallet-top">
              <div className="wallet-id">
                <span className="addr">{data.addressShort}</span>
                <span className="tag">{data.chain}</span>
                <span className="tag">{data.activeDays}d active</span>
              </div>
              <div className="wallet-pnl">
                <div className="big">
                  +${(data.pnl7d / 1000).toFixed(1)}K
                </div>
                <div className="roi">ROI +{data.roi7d.toFixed(1)}%</div>
              </div>
            </div>

            <div className="style-line">
              <strong>Style :</strong> {data.style}
            </div>

            <div className="insights">
              {data.insights.map((ins) => (
                <div key={ins.title} className="insight">
                  <div className="title">
                    {ins.icon} {ins.title}
                  </div>
                  <div className="body">{ins.body}</div>
                </div>
              ))}
            </div>

            <div className="stats-grid">
              {data.stats.map((s) => (
                <div key={s.label} className="stat-box">
                  <div className="lab">{s.label}</div>
                  <div className={`val ${s.tone ?? ''}`}>{s.value}</div>
                </div>
              ))}
            </div>

            <div className="pnl-dist">
              <div className="bar">
                {data.pnlBuckets.map((b) => (
                  <span
                    key={b.label}
                    style={{
                      width: `${(b.count / totalCoins) * 100}%`,
                      background: b.color,
                    }}
                    title={`${b.label}: ${b.count}`}
                  />
                ))}
              </div>
              <div className="legend">
                <span>{totalCoins} coins</span>
                {data.pnlBuckets.map((b) => (
                  <span key={b.label}>
                    {b.label} {b.count}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <div className="score-row">
            <div className="score-card">
              <div className="name">Track-Record Score</div>
              <div className="score" style={{ color: scoreColor(data.trackScore) }}>
                {data.trackScore}
                <span style={{ fontSize: 16, color: 'var(--text-dim)' }}>/100</span>
              </div>
              <div className="hint">Is he actually skilled (distribution-adjusted)</div>
              <div className="thin-bar">
                <span
                  style={{
                    width: `${data.trackScore}%`,
                    background: barTone(data.trackScore),
                  }}
                />
              </div>
              <div className="warn-line">{data.warning}</div>
            </div>
            <div className="score-card">
              <div className="name">Copy-Tradeability Score</div>
              <div className="score" style={{ color: scoreColor(data.copyScore) }}>
                {data.copyScore}
                <span style={{ fontSize: 16, color: 'var(--text-dim)' }}>/100</span>
              </div>
              <div className="hint">How much YOU could actually capture</div>
              <div className="thin-bar">
                <span
                  style={{
                    width: `${Math.max(data.copyScore, 2)}%`,
                    background: barTone(data.copyScore),
                  }}
                />
              </div>
            </div>
            <div className="score-card">
              <div className="name">Dev Legitimacy Score</div>
              <div className="score" style={{ color: scoreColor(data.devScore) }}>
                {data.devScore}
                <span style={{ fontSize: 16, color: 'var(--text-dim)' }}>/100</span>
              </div>
              <div className="hint">Are the tokens he launches actually legit</div>
              <div className="thin-bar">
                <span style={{ width: '0%', background: barTone(data.devScore) }} />
              </div>
            </div>
          </div>

          <section className="panel factor-panel">
            <div className="factor-tabs">
              {(
                [
                  ['track', 'Track · factors'],
                  ['copy', 'Copy · factors'],
                  ['dev', 'Dev · factors'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`factor-tab ${factorTab === id ? 'active' : ''}`}
                  onClick={() => setFactorTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="factor-list">
              {factors?.map((f) => (
                <div key={f.key} className="factor-item">
                  <div className="top">
                    <span>{f.label}</span>
                    <span className="score-n" style={{ color: scoreColor(f.score) }}>
                      {f.score}
                    </span>
                  </div>
                  <div className="thin-bar">
                    <span
                      style={{
                        width: `${Math.max(f.score, 1)}%`,
                        background: barTone(f.score),
                      }}
                    />
                  </div>
                  <div className="detail">{f.detail}</div>
                </div>
              ))}
            </div>

            <div className="edge-line">
              <span className="num">{data.edgeScore}</span>
              <span>Edge type · {data.edgeType}</span>
            </div>
          </section>

          <CopyTradeBacktest data={data} />

          <div className="footer-warn">
            <span>{data.footerWarn}</span>
            <a href="#learn" onClick={(e) => e.preventDefault()}>
              Learn only
            </a>
          </div>
        </>
      )}
    </div>
  );
}
