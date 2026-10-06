import { useState } from 'react';
import type { Position } from '../types';

/*
 * DexScreener chart for each held Solana coin, one tab per coin.
 * Off by default: nothing is requested from DexScreener until the switch is turned on.
 * Used in App.tsx under "Tracked holdings": <LivePositionChart positions={trackedPositions} />
 */

const STORAGE_KEY = 'gmgn.liveChart.enabled.v1';
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Boolean setting kept in localStorage; falls back to `initial` when storage is unavailable. */
function useStoredToggle(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : raw === 'true';
    } catch {
      return initial;
    }
  });
  const update = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      // Storage blocked: the choice still applies until the page reloads.
    }
  };
  return [value, update];
}

function chartUrl(mint: string): string {
  return `https://dexscreener.com/solana/${encodeURIComponent(mint)}?embed=1&theme=dark&trades=0&info=0`;
}

interface Props {
  positions: Position[];
}

export function LivePositionChart({ positions }: Props) {
  const [enabled, setEnabled] = useStoredToggle(STORAGE_KEY, false);
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
            onChange={(e) => setEnabled(e.target.checked)}
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
