import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDiscover, type DiscoveredToken } from '../api';
import { hasLocalToken } from '../localToken';
import type { ScreenToken, TradeMode } from '../types';
import { shortMint } from '../watchlist';

interface Props {
  buyAmount: number;
  mode: TradeMode;
  onBuy: (t: ScreenToken) => void;
  onWatch: (mint: string, symbol: string) => void;
}

const REFRESH_MS = 60_000;

function usd(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function age(m: number | null): string {
  if (m == null) return '—';
  if (m < 60) return `${m}m`;
  if (m < 60 * 48) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}
function pct(n: number | null) {
  if (n == null) return <span>—</span>;
  return <span className={n >= 0 ? 'safe-ok' : 'safe-bad'}>{(n >= 0 ? '+' : '') + n.toFixed(1)}%</span>;
}

function toBuyToken(t: DiscoveredToken): ScreenToken {
  const ok = t.safety.ok;
  const blocker = t.safety.blockers[0];
  return {
    id: t.mint,
    symbol: t.symbol || shortMint(t.mint),
    mintShort: shortMint(t.mint),
    address: t.mint,
    age: age(t.ageMinutes),
    ruleIcons: Array(6).fill(ok ? 'pass' : 'fail'),
    safe: ok ? (t.safety.score != null ? `✓ score ${t.safety.score}` : '✓ gates pass') : `✗ ${(blocker || 'blocked').slice(0, 42)}`,
    safeOk: ok,
    bund: 0, dev: 0, t10: 0, smart: 0, kol: 0,
    devScore: t.safety.score != null ? Math.max(0, 100 - t.safety.score) : 0,
    devLabel: ok ? 'GOOD' : 'BAD',
    timing: `liq ${usd(t.liquidityUsd)}`,
    llm: ok ? 'HOLD' : 'FAIL',
    priority: t.ranking?.score ?? 0,
    decision: !ok ? 'blocked' : t.ranking?.action === 'candidate' ? 'buy' : 'watch',
    thesis: ok
      ? `${t.ranking?.version || 'Safety only'}: ${t.ranking?.reasons.join(' · ') || 'No opportunity score available'} · liq ${usd(t.liquidityUsd)}.`
      : `Blocked: ${blocker || 'failed safety'}`,
  };
}

export function DiscoveryFeed({ buyAmount, mode, onBuy, onWatch }: Props) {
  const [source, setSource] = useState<'trending' | 'new'>('trending');
  const [tokens, setTokens] = useState<DiscoveredToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [safeOnly, setSafeOnly] = useState(false);
  const [minLiq, setMinLiq] = useState<number | null>(null);

  const requestState = useRef<{ id: number; pending: string | null }>({ id: 0, pending: null });
  const load = useCallback(async (src: 'trending' | 'new') => {
    const request = requestState.current;
    if (request.pending === src) return;
    const id = ++request.id;
    if (!hasLocalToken()) {
      setErr('Paste your access token to load the discovery feed');
      return;
    }
    request.pending = src;
    setLoading(true);
    setTokens([]);
    setAt(null);
    setErr(null);
    try {
      const res = await fetchDiscover(src);
      if (id !== request.id) return;
      setTokens(res.tokens);
      setAt(res.at);
      setMinLiq(res.minLiquidityUsd);
    } catch (e) {
      if (id !== request.id) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === request.id) { request.pending = null; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    const request = requestState.current;
    const initial = window.setTimeout(() => void load(source), 0);
    const t = auto ? window.setInterval(() => { if (!document.hidden) void load(source); }, REFRESH_MS) : undefined;
    return () => { window.clearTimeout(initial); window.clearInterval(t); request.id++; request.pending = null; };
  }, [source, auto, load, mode]);

  const rows = safeOnly ? tokens.filter((t) => t.safety.ok) : tokens;
  const passed = tokens.filter((t) => t.safety.ok).length;

  return (
    <section className={`panel discover-panel ${loading ? 'scanning' : ''}`} aria-labelledby="discover-title">
      <div className="panel-head">
        <h2 id="discover-title">Discover</h2>
        <span className="panel-sub">DexScreener</span>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Discovery source">
          <button type="button" aria-pressed={source === 'trending'} onClick={() => setSource('trending')}>
            Top boosted
          </button>
          <button type="button" aria-pressed={source === 'new'} onClick={() => setSource('new')}>
            Latest profiles
          </button>
        </div>
      </div>
      <div className="discover-controls">
        <span>
          {at ? `${passed}/${tokens.length} pass` : loading ? 'scanning…' : 'not scanned yet'}
          {minLiq != null && <> · liq ≥ {usd(minLiq)}</>}
          {at && <> · {new Date(at).toLocaleTimeString()}</>}
        </span>
        <div className="spacer" />
        <label className="mini-check">
          <input type="checkbox" checked={safeOnly} onChange={(e) => setSafeOnly(e.target.checked)} /> Passed only
        </label>
        <label className="mini-check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto 60s
        </label>
        <button type="button" className="btn-ghost btn-small" onClick={() => void load(source)} disabled={loading}>
          {loading ? 'Scanning…' : 'Scan'}
        </button>
      </div>
      {err && <div className="cred-msg err">{err}</div>}
      <ul className="discover-list" aria-label="Discovered tokens">
        {rows.length === 0 && (
          <li className="discover-empty help">{loading ? 'Scanning feed…' : 'No tokens right now.'}</li>
        )}
        {rows.map((t) => (
          <li key={t.mint} className={`discover-row ${t.safety.ok ? 'is-pass' : 'is-blocked'}`}>
            <div className="discover-id">
              <span className="sym">
                {t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.symbol || shortMint(t.mint)}</a> : t.symbol}
              </span>
              <span className="meta" title={t.mint}>{shortMint(t.mint)} · {age(t.ageMinutes)}</span>
            </div>
            <div className="discover-change">{pct(t.change1hPct)} <span className="meta">1h</span></div>
            <div className="discover-stats">
              <span>liq {usd(t.liquidityUsd)}</span>
              <span>mc {usd(t.marketCapUsd)}</span>
              <span>b/s {t.buys1h ?? '—'}/{t.sells1h ?? '—'}</span>
            </div>
            <div />
            <div className="discover-verdict">
              <span className={t.safety.ok ? 'safe-ok' : 'safe-bad'} title={[...t.safety.blockers, ...t.safety.warnings].join('\n')}>
                {t.safety.ok
                  ? t.safety.score != null ? `✓ risk ${t.safety.score}` : '✓ pass'
                  : `✗ ${(t.safety.blockers[0] || 'blocked').slice(0, 36)}`}
              </span>
              <span className="meta" title={`Rules-based, unvalidated. ${t.ranking?.reasons.join(' · ') ?? ''}`}>
                {t.ranking ? `${t.ranking.action} · ${t.ranking.score ?? '—'}/100` : 'Unranked'}
              </span>
            </div>
            <div className="discover-actions">
              <button type="button" className="btn-ghost btn-small" onClick={() => onWatch(t.mint, t.symbol)}>
                + Watch
              </button>
              {t.safety.ok ? (
                <button type="button" className="buy-btn btn-small" disabled={loading || Boolean(err)} onClick={() => onBuy(toBuyToken(t))}>
                  BUY {buyAmount} SOL
                </button>
              ) : (
                <span className="blocked-btn btn-small">BLOCKED</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
