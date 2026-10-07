import type { Chain, TradeMode } from '../types';

interface Props {
  mode: TradeMode;
  chain: Chain;
  /** Time left before LIVE auto-locks; null outside a LIVE session. */
  liveRemainingMs: number | null;
  onLock: () => void;
}

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** One-line description of what the current mode can and cannot do. */
export function modeMessage(mode: TradeMode, chain: Chain): string {
  if (mode === 'SHADOW') return 'SHADOW · mock data and intents only · nothing touches a chain';
  if (chain !== 'SOL') {
    return mode === 'PAPER'
      ? `PAPER · quote and copy intents only on ${chain} · nothing is signed or broadcast`
      : `LIVE · intent only on ${chain} · nothing is signed in this app`;
  }
  return mode === 'PAPER'
    ? 'PAPER · virtual SOL with fresh Jupiter quotes · nothing is signed or broadcast'
    : 'LIVE · real funds · your wallet approves every transaction';
}

/** Full-width strip that keeps the active trading mode visible at all times. */
export function ModeBanner({ mode, chain, liveRemainingMs, onLock }: Props) {
  return (
    <div className="mode-banner" data-tour="mode-banner" role="status" aria-label={`Trading mode ${mode}`}>
      <span className="mode-banner-dot" aria-hidden />
      <span>{modeMessage(mode, chain)}</span>
      {mode === 'SHADOW' && <span className="mode-banner-hint">switch to PAPER for live screening</span>}
      {mode === 'LIVE' && (
        <>
          {liveRemainingMs !== null && (
            <span className="mode-banner-hint" aria-live="off">auto-locks in {formatRemaining(liveRemainingMs)}</span>
          )}
          <button type="button" className="mode-banner-lock" onClick={onLock}>
            LOCK NOW
          </button>
        </>
      )}
    </div>
  );
}
