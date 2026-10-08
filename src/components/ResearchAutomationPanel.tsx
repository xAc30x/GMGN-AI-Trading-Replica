import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchResearchAutomation, updateResearchAutomation, type ResearchAutomationResponse } from '../api';

const sol = (value: string | null) => value == null ? '—' : (Number(value) / 1e9).toFixed(6);
const time = (value: number | null) => value ? new Date(value).toLocaleTimeString() : 'Not yet';
export function ResearchAutomationPanel() {
  const [data, setData] = useState<ResearchAutomationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const reading = useRef(false);
  const changing = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (reading.current || changing.current) return;
    reading.current = true;
    const request = generation.current;
    try {
      const result = await fetchResearchAutomation();
      if (request === generation.current) { setData(result); setError(null); }
    } catch (e) { if (request === generation.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { reading.current = false; }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15000);
    const clockTimer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.clearInterval(clockTimer); };
  }, [load]);
  const change = async (patch: Partial<ResearchAutomationResponse['settings']>) => {
    if (changing.current) return;
    changing.current = true; generation.current++; setBusy(true);
    try { await updateResearchAutomation(patch); setData(await fetchResearchAutomation()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { changing.current = false; setBusy(false); }
  };
  const running = Boolean(data?.serviceEnabled && data.settings.scanning);
  return <section className="panel research-panel automation-panel" aria-label="Research automation">
    <div className="panel-head"><h2>Background research &amp; paper comparison</h2></div>
    <div className="research-content">
      {error && <p className="cred-msg err" role="alert">{error}</p>}
      {data && <>
        <p className="help">Every {data.intervalMs / 1000}s: scan Top boosted and Latest profiles, save rankings and track future outcomes.
          Runs with the backend even when this page is closed. Settings persist across restarts.</p>
        <div className="research-controls" role="group" aria-label="Background research controls" aria-describedby="paper-scope">
          <button className="btn-ghost" disabled={busy} onClick={() => void change({ scanning: !data.settings.scanning })}>
            {data.settings.scanning ? 'Pause background scans' : 'Resume background scans'}</button>
          <button className="btn-ghost" disabled={busy || (!data.settings.autoPaper && !running)}
            onClick={() => void change({ autoPaper: !data.settings.autoPaper })}>
            {data.settings.autoPaper ? 'Pause automatic paper entries' : 'Start paper comparison'}</button>
          <span role="status" aria-live="polite">Scans: {running ? 'running' : 'paused'} · Automatic paper entries: {running && data.settings.autoPaper ? 'running' : 'paused'}</span>
        </div>
        <p className="help" id="paper-scope">Starting the comparison enables virtual entries until paused: {data.policy.amountSol} SOL per entry,
          at most {data.policy.maxPositions} open positions per strategy, one new position per feed scan,
          {` ${data.policy.cooldownMs / 3600000}`}h coin cooldown. Each strategy has its own 1 SOL virtual account.
          Pausing stops new entries; existing paper positions keep their exit rules. No wallet access or real trades.</p>
        {!data.serviceEnabled && <p className="cred-msg err">The market-data service gate is disabled. Background scans and paper monitoring are paused.</p>}
        {data.monitorError && <p className="cred-msg err">Paper monitor: {data.monitorError}</p>}
        {data.schedulerError && <p className="cred-msg err">Scheduler: {data.schedulerError}</p>}
        <div className="research-jobs">{data.jobs.map(job => <p className="help" key={job.source}>
          <strong>{job.source === 'trending' ? 'Top boosted' : 'Latest profiles'}</strong> · last attempt {time(job.last_at)} · next {running ? time(job.next_at) : 'paused'}
          {job.lease_until > clock && ' · scan in progress'}{job.last_error && ` · retry ${job.failures}: ${job.last_error}`}
        </p>)}</div>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Paper strategy comparison"><table className="screen">
          <thead><tr><th>Strategy</th><th>Open / closed</th><th>Net P&amp;L (SOL)</th><th>Expectancy / trade (SOL)</th><th>Profit factor</th><th>Observed drawdown</th></tr></thead>
          <tbody>{data.accounts.map(a => <tr key={a.id}>
            <td>{a.id}{a.currentVersion === false && <div className="meta">Retired · monitoring existing positions</div>}<div className={`strategy-verdict strategy-verdict-${a.verdict.status}`}>{a.verdict.text}</div>
              {a.verdict.status !== 'too_few' && <div className="meta">{a.metrics.evaluation}</div>}</td>
            <td>{a.portfolio.stats.open} / {a.metrics.closed}<div className="meta">{a.metrics.wins} wins{a.metrics.winRatePct == null ? '' : ` (${a.metrics.winRatePct.toFixed(0)}%)`}</div></td>
            <td>{sol(clock - data.at <= 45000 ? a.portfolio.stats.netPnlLamports : null)}<div className="meta">Realized {sol(a.portfolio.stats.realisedPnlLamports)}</div></td>
            <td>{a.metrics.netExpectancySol == null ? '—' : a.metrics.netExpectancySol.toFixed(6)}</td>
            <td>{a.metrics.profitFactor == null ? a.metrics.noLosingTrades ? 'No losses yet' : '—' : a.metrics.profitFactor.toFixed(2)}</td>
            <td>{a.metrics.maxObservedDrawdownPct == null ? '—' : `${a.metrics.maxObservedDrawdownPct.toFixed(2)}%`}<div className="meta">{a.metrics.missingEquitySamples} missing marks</div></td>
          </tr>)}</tbody>
        </table></div>
        <p className="help">momentum-quality-v1 uses liquidity, pair age, price momentum, buy pressure and recent volume.
          safety-feed-v1 takes the first eligible coin in feed order. Both use the same entry size, costs and exits.
          This is a prospective test of fixed rules; scores are not win probabilities. Closed-trade expectancy excludes open trades;
          net P&amp;L includes fresh marks. Drawdown is sampled and can miss moves during outages. Results are not proof of an edge.</p>
        <details><summary>Latest automatic decisions</summary>
          {data.decisions.length === 0 && <p className="help">No automatic decisions yet.</p>}
          <ul className="research-decisions">{data.decisions.map(d => <li key={d.id}>
            <strong>{d.account_id} · {d.status}</strong> · {time(d.at)} · {d.mint ? `${d.mint.slice(0, 6)}…` : 'No selection'}
            <div className="help">{d.data.error || d.data.reason || d.data.selectionReason || d.data.ranking?.reasons.join(' · ') || d.data.source}</div>
          </li>)}</ul>
        </details>
        <details><summary>Automatic paper positions</summary>
          {data.accounts.map(a => <div key={a.id}><h3>{a.id}</h3>
            {a.portfolio.positions.length === 0 && <p className="help">No positions yet.</p>}
            <ul className="research-decisions">{a.portfolio.positions.slice(0, 20).map(p => <li key={p.id}>
              {p.symbol} · {p.state} · {p.exitReason || p.exitPending || 'Monitoring exits'}
              {p.lastError && <div className="safe-bad">{p.lastError}</div>}
            </li>)}</ul>
          </div>)}
        </details>
      </>}
    </div>
  </section>;
}
