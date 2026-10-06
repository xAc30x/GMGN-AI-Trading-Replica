import { useState } from 'react';
import type { Position } from '../types';

/*
 * DexScreener chart for each held Solana coin, one tab per coin.
 * Off by default: nothing is requested from DexScreener until the switch is turned on.
 * Used in App.tsx under the open positions. The on/off setting is shared with Settings → Experimental
 * (see useLiveChartSetting).
 */

const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function chartUrl(mint: string): string {
  return `https://dexscreener.com/solana/${encodeURIComponent(mint)}?embed=1&theme=dark&trades=0&info=0`;
}

interface Props {
  positions: Position[];
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
}

export function LivePositionChart({ positions, enabled, onEnabledChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const chartable = positions.filter(
    (p): p is Position & { address: string } =>
      !p.demo && p.chain === 'SOL' && typeof p.address === 'string' && SOLANA_MINT.test(p.address),
  );
  const selected = chartable.find((p) => p.id === selectedId) ?? chartable[0];

  return (
    <section className="panel live-chart">
      <div className="panel-head">
        <h2>Live chart</h2>
        <span className="spacer" />
        <label className="live-chart-switch">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
          />
          Show chart
        </label>
      </div>
      {!enabled ? (
        <div className="live-chart-note">Chart is off. Turning it on loads charts from dexscreener.com.</div>
      ) : !selected ? (
        <div className="live-chart-note">No held Solana coins to chart.</div>
      ) : (
        <>
          <div className="tabs live-chart-tabs" role="tablist" aria-label="Held coins">
            {chartable.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === selected.id}
                className={`tab ${p.id === selected.id ? 'active' : ''}`}
                onClick={() => setSelectedId(p.id)}
              >
                {p.symbol}
              </button>
            ))}
          </div>
          <iframe
            key={selected.id}
            className="live-chart-frame"
            title={`${selected.symbol} chart on DexScreener`}
            src={chartUrl(selected.address)}
            sandbox="allow-scripts allow-same-origin allow-popups"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        </>
      )}
    </section>
  );
}
