import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMintSafety, type HealthResponse, type MintSafetyResponse, type WatchlistScanItem } from '../api';
import { age, usd } from '../format';
import { checkStatus, safetyVerdict, type InspectTarget } from '../safetyChecks';
import type { TradeMode } from '../types';
import { InspectorTrade } from './InspectorTrade';
import { SafetyCheckList } from './SafetyChecks';

interface Props {
  target: InspectTarget | null;
  onClose: () => void;
  mode: TradeMode;
  health: HealthResponse | null;
  amount: number;
  onAmount: (n: number) => void;
  liveExposureSol: number;
  liveOpenMints: string[];
  paperVersion: number;
  /** Opens the existing buy dialog for this token at the chosen amount. */
  onTrade: (target: InspectTarget) => void;
}

type SafetyResult = MintSafetyResponse | WatchlistScanItem;

function pctText(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/**
 * Read-only details for one token: stats, a PASS / REVIEW / BLOCKED verdict and every safety
 * check the server ran. Watchlist rows already carry their scan; Discover rows only have a
 * summary, so the full checks are fetched once when the token is opened.
 * Render with key={mint} so each token starts with fresh state.
 */
export function TokenInspector({ target, onClose, mode, health, amount, onAmount, liveExposureSol, liveOpenMints, paperVersion, onTrade }: Props) {
  const [fetched, setFetched] = useState<SafetyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);

  const mint = target?.mint;
  const runCheck = useCallback(async () => {
    if (!mint) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetchMintSafety(mint);
      if (alive.current) setFetched(res);
    } catch (e) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [mint]);

  const hasScan = Boolean(target?.scan);
  useEffect(() => {
    alive.current = true;
    const t = hasScan ? undefined : window.setTimeout(() => void runCheck(), 0);
    return () => {
      alive.current = false;
      window.clearTimeout(t);
    };
  }, [hasScan, runCheck]);

  if (!target) {
    return (
      <aside className="ws-col ws-inspector panel" aria-label="Inspector">
        <div className="panel-head">
          <h2>Inspector</h2>
        </div>
        <p className="help">Select a token in Discover or Watchlist to see its safety checks.</p>
      </aside>
    );
  }

  const result: SafetyResult | null = fetched ?? target.scan ?? null;
  const d = target.discovered;
  const rc = result?.rug?.rugcheck;
  const verdict = result
    ? safetyVerdict(result)
    : d
      ? safetyVerdict({ ok: d.safety.ok, blockers: d.safety.blockers, warnings: d.safety.warnings })
      : null;
  const blockers = result?.blockers ?? d?.safety.blockers ?? [];
  const warnings = result?.warnings ?? d?.safety.warnings ?? [];
  // What the user acknowledges: the warning checks themselves, or the server's warning list if none are marked.
  const warnChecks = (result?.checks ?? []).filter((c) => checkStatus(c) === 'warn').map((c) => c.detail.replace(/^warn:\s*/i, ''));
  const ackWarnings = warnChecks.length > 0 ? warnChecks : warnings;

  const stats: [string, string][] = [];
  if (d) {
    stats.push(
      ['Price', d.priceUsd != null ? `$${d.priceUsd.toPrecision(3)}` : '—'],
      ['Liquidity', usd(d.liquidityUsd)],
      ['Market cap', usd(d.marketCapUsd)],
      ['1h', pctText(d.change1hPct)],
      ['24h', pctText(d.change24hPct)],
      ['Volume 24h', usd(d.volume24hUsd)],
      ['Buys / sells 1h', `${d.buys1h ?? '—'} / ${d.sells1h ?? '—'}`],
      ['Age', age(d.ageMinutes)],
    );
  } else if (rc?.totalMarketLiquidity != null) {
    stats.push(['Liquidity', usd(rc.totalMarketLiquidity)]);
  }
  if (rc?.scoreNormalised != null) stats.push(['RugCheck score', String(rc.scoreNormalised)]);
  if (rc?.totalHolders != null) stats.push(['Holders', rc.totalHolders.toLocaleString()]);

  return (
    <aside className="ws-col ws-inspector panel" aria-label="Inspector">
      <div className="panel-head">
        <h2>{target.symbol}</h2>
        <span className="panel-sub">{target.source === 'discover' ? 'from Discover' : 'from Watchlist'}</span>
        <div className="spacer" />
        <button type="button" className="x" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </div>
      <code className="inspector-mint" title="Mint address">{target.mint}</code>
      {d?.url && (
        <a className="inspector-link" href={d.url} target="_blank" rel="noreferrer">
          Open on DexScreener
        </a>
      )}

      {stats.length > 0 && (
        <dl className="inspector-stats">
          {stats.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {d?.ranking && (
        <p className="help" title="Rules-based and unvalidated">
          Ranking {d.ranking.action} · {d.ranking.score ?? '—'}/100{d.ranking.reasons.length > 0 && ` · ${d.ranking.reasons.join(' · ')}`}
        </p>
      )}

      {verdict && (
        <div className={`verdict verdict-${verdict.toLowerCase()}`} role="status" aria-label={`Safety verdict ${verdict}`}>
          <b>{verdict}</b>
          <span>
            {verdict === 'BLOCKED'
              ? blockers[0] ?? 'Failed safety checks'
              : verdict === 'REVIEW'
                ? `${warnings.length || 'Some'} warning${warnings.length === 1 ? '' : 's'} to review`
                : 'All checks passed'}
          </span>
        </div>
      )}
      {(blockers.length > 1 || warnings.length > 0) && (
        <ul className="verdict-notes">
          {blockers.slice(1).map((b) => <li key={`b-${b}`} className="check-fail">{b}</li>)}
          {warnings.map((w) => <li key={`w-${w}`} className="check-warn">{w}</li>)}
        </ul>
      )}

      <div className="inspector-checks-head">
        <h3>Safety checks</h3>
        <span className="meta">{result ? `${result.checks.length} run` : loading ? 'checking…' : ''}</span>
        <div className="spacer" />
        <button type="button" className="btn-ghost btn-small" onClick={() => void runCheck()} disabled={loading}>
          {loading ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      {err && <div className="cred-msg err">{err}</div>}
      {result && <SafetyCheckList checks={result.checks} />}
      {!result && !loading && !err && <p className="help">No checks yet.</p>}

      <InspectorTrade
        key={mode}
        mode={mode}
        mint={target.mint}
        verdict={result ? safetyVerdict(result) : null}
        checked={Boolean(result) && !loading}
        checking={loading}
        warnings={ackWarnings}
        health={health}
        amount={amount}
        onAmount={onAmount}
        liveExposureSol={liveExposureSol}
        liveOpenMints={liveOpenMints}
        paperVersion={paperVersion}
        onTrade={() => onTrade(target)}
      />
    </aside>
  );
}
