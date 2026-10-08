import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLiveTradeRecord, type LiveTradeRecordResponse } from '../api';

const sol = (v: string) => (Number(v) / 1e9).toFixed(6);
const short = (v: string) => `${v.slice(0, 6)}…`;

/** Read-only view of live trades as recorded on chain. Never builds, signs or sends anything. */
export function LiveTradeRecord() {
  const [data, setData] = useState<LiveTradeRecordResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);
  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try { setData(await fetchLiveTradeRecord()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { reading.current = false; }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  return <section className="panel research-panel" aria-label="Live trade record">
    <div className="panel-head"><h2>Live trade record</h2></div>
    <div className="research-content">
      <p className="help">Real-money trades as the blockchain recorded them, saved on the server so clearing the browser does not lose them.
        Cost is all the SOL that left the wallet (swap, network fees and new token account rent). Failed transactions still cost their fee.</p>
      {error && <p className="cred-msg err" role="alert">{error}</p>}
      {data?.sync.error && <p className="cred-msg err">Some trades could not be looked up yet: {data.sync.error}</p>}
      {data && data.sync.waiting > 0 && !data.sync.error && <p className="help">{data.sync.waiting} sent trade(s) not on chain yet; checking again shortly.</p>}
      {data && <>
        <p className={data.dailyLoss.blocked ? 'cred-msg err' : 'help'} role="status">
          {data.dailyLoss.blocked
            ? `Daily loss limit reached: new live buys are paused until ${new Date(data.dailyLoss.resetsAt).toLocaleString()}. Selling still works.`
            : `Daily loss limit: ${sol(data.dailyLoss.lossTodayLamports)} of ${sol(data.dailyLoss.limitLamports)} SOL lost today (resets at 00:00 UTC).`}
          {' '}Only sold tokens and failed-trade fees count; a drop in tokens you still hold does not count until you sell.
        </p>
        <div className="research-stats">
          <span>Realized P&amp;L <strong>{sol(data.totals.realisedPnlLamports)} SOL</strong></span>
          <span>Fees paid <strong>{sol(data.totals.feesLamports)} SOL</strong></span>
          <span>Cost still held <strong>{sol(data.totals.openCostLamports)} SOL</strong></span>
          <span>Trades <strong>{data.trades.length}</strong></span>
        </div>
        <div className="table-wrap"><table className="screen">
          <thead><tr><th>Token</th><th>Spent</th><th>Received</th><th>Cost still held</th><th>Realized P&amp;L</th><th>Trades</th></tr></thead>
          <tbody>
            {data.positions.length === 0 && <tr><td colSpan={6}>No live trades recorded yet.</td></tr>}
            {data.positions.map(p => <tr key={`${p.wallet}:${p.mint}`}>
              <td title={p.mint}>{short(p.mint)}</td>
              <td>{sol(p.boughtLamports)} SOL</td>
              <td>{sol(p.soldLamports)} SOL</td>
              <td>{sol(p.costLamports)} SOL</td>
              <td className={BigInt(p.realisedPnlLamports) < 0n ? 'safe-bad' : undefined}>{sol(p.realisedPnlLamports)} SOL</td>
              <td>{p.trades}{p.failed > 0 && <div className="meta">{p.failed} failed</div>}</td>
            </tr>)}
          </tbody>
        </table></div>
      </>}
    </div>
  </section>;
}
