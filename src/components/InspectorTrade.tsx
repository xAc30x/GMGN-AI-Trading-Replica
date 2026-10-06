import { useEffect, useState } from 'react';
import { fetchPaperPortfolio, type HealthResponse, type PaperPortfolioResponse } from '../api';
import type { Verdict } from '../safetyChecks';
import { AMOUNT_PRESETS, tradeGate, tradeRails } from '../tradeGate';
import type { TradeMode } from '../types';

interface Props {
  mode: TradeMode;
  mint: string;
  verdict: Verdict | null;
  checked: boolean;
  checking: boolean;
  /** Warning texts to acknowledge, already de-duplicated. */
  warnings: string[];
  health: HealthResponse | null;
  amount: number;
  onAmount: (n: number) => void;
  /** LIVE positions this browser knows about for the connected wallet. */
  liveExposureSol: number;
  liveOpenMints: string[];
  /** Bumps after a paper position opens or closes, so the holding check refreshes. */
  paperVersion: number;
  onTrade: () => void;
}

const LAMPORTS = 1e9;

/**
 * Trade controls for the inspected token. The button only opens the existing buy dialog,
 * which keeps every check it has today (fresh quote, mint re-scan, confirmation, wallet).
 */
export function InspectorTrade(p: Props) {
  const [acked, setAcked] = useState(false);
  const [paper, setPaper] = useState<PaperPortfolioResponse | null>(null);
  const [paperErr, setPaperErr] = useState<string | null>(null);

  const isPaper = p.mode === 'PAPER';
  useEffect(() => {
    if (!isPaper) return;
    let cancelled = false;
    fetchPaperPortfolio()
      .then((r) => { if (!cancelled) { setPaper(r); setPaperErr(null); } })
      .catch((e) => { if (!cancelled) setPaperErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [isPaper, p.paperVersion]);

  const paperOpen = paper?.positions.filter((x) => x.state === 'open') ?? [];
  const held = isPaper
    ? paperOpen.some((x) => x.mint === p.mint)
    : p.liveOpenMints.includes(p.mint);
  const maxNative = typeof p.health?.maxNativeAmount === 'number' ? p.health.maxNativeAmount : null;
  const presets = AMOUNT_PRESETS.filter((a) => maxNative === null || a <= maxNative);

  const gate = tradeGate({
    mode: p.mode,
    amount: p.amount,
    maxNative,
    checked: p.checked,
    checking: p.checking,
    verdict: p.verdict,
    warningCount: p.warnings.length,
    acknowledged: acked,
    held,
    // PAPER reads open positions from the server's paper portfolio.
    heldKnown: !isPaper || paper !== null,
  });
  const rails = tradeRails({
    mode: p.mode,
    amount: p.amount,
    maxNative,
    exposureSol: p.liveExposureSol,
    openPositions: p.liveOpenMints.length,
    held,
    maxPortfolioSol: typeof p.health?.maxPortfolioSol === 'number' ? p.health.maxPortfolioSol : null,
    maxOpenPositions: typeof p.health?.maxOpenPositions === 'number' ? p.health.maxOpenPositions : null,
  });

  const model = paper?.model;
  const exitPlan = isPaper
    ? model
      ? `Modeled exits: ${model.stopLossPct}% stop · +${model.takeProfitPct}% target · ${Math.round(model.maxHoldMs / 60000)} min timeout. Priced at the quote's minimum output, including fees and rent.`
      : 'Modeled exits load from the paper portfolio.'
    : 'Exits are not placed on-chain. You close the position yourself, with wallet approval.';

  return (
    <section className="inspector-trade" aria-label="Trade">
      <div className="inspector-checks-head">
        <h3>Trade</h3>
        <span className="meta">{isPaper ? 'virtual SOL · nothing is sent' : 'real SOL · your wallet signs'}</span>
      </div>

      <div className="seg amount-seg" role="group" aria-label="Buy amount">
        {presets.map((a) => (
          <button key={a} type="button" aria-pressed={p.amount === a} onClick={() => p.onAmount(a)}>
            {a} SOL
          </button>
        ))}
      </div>

      {rails.length > 0 ? (
        <ul className="rails" aria-label="Limits">
          {rails.map((r) => (
            <li key={r.label} className={`rail rail-${r.tone}`}>
              <span>{r.label}</span>
              <span className="rail-value">{r.value}</span>
              <span className="rail-bar" aria-hidden><span style={{ width: `${r.pct}%` }} /></span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="help">Limits load from the server status.</p>
      )}
      {!isPaper && rails.length > 1 && (
        <p className="help">Exposure and positions are estimated from this browser's records. The server re-checks on-chain.</p>
      )}
      {isPaper && paper && (
        <p className="help">
          Paper cash {(Number(paper.account.cash) / LAMPORTS).toFixed(4)} SOL · {paperOpen.length} open paper position{paperOpen.length === 1 ? '' : 's'}
        </p>
      )}
      {paperErr && <div className="cred-msg err">Paper portfolio unavailable: {paperErr}</div>}

      <p className="exit-note">{exitPlan}</p>

      {gate.needsAck && (
        <label className="ack-box">
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
          <span>
            I've reviewed {p.warnings.length > 1 ? `${p.warnings.length} warnings` : 'the warning'}: {p.warnings.join('; ')}
          </span>
        </label>
      )}

      <button type="button" className="trade-btn" disabled={!gate.can} onClick={() => { if (gate.can) p.onTrade(); }}>
        {gate.label}
      </button>
    </section>
  );
}
