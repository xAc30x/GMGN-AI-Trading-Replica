import { useCallback, useEffect, useState } from 'react';
import {
  fetchWatchlistScan,
  type WatchlistScanItem,
} from '../api';
import { hasLocalToken } from '../localToken';
import type { ScreenToken, TradeMode } from '../types';
import {
  addWatchMint,
  loadWatchlist,
  removeWatchMint,
  shortMint,
  type WatchMint,
} from '../watchlist';

interface Props {
  buyAmount: number;
  onBuyAmount: (n: number) => void;
  onBuy: (t: ScreenToken) => void;
  mode: TradeMode;
}

function toScreenToken(w: WatchMint, scan?: WatchlistScanItem): ScreenToken {
  const ok = scan ? scan.ok : false;
  const score = scan?.rug?.rugcheck?.scoreNormalised;
  const liq = scan?.rug?.rugcheck?.totalMarketLiquidity;
  const blocker = scan?.blockers?.[0];
  return {
    id: w.mint,
    symbol: w.symbol || shortMint(w.mint),
    mintShort: shortMint(w.mint),
    address: w.mint,
    age: 'watch',
    ruleIcons: ok
      ? ['pass', 'pass', 'pass', 'pass', 'pass', 'pass']
      : ['fail', 'fail', 'fail', 'fail', 'fail', 'fail'],
    safe: ok
      ? score != null
        ? `✓ score ${score}`
        : '✓ gates pass'
      : blocker
        ? `✗ ${blocker.slice(0, 42)}`
        : '✗ blocked',
    safeOk: ok,
    bund: 0,
    dev: 0,
    t10: 0,
    smart: 0,
    kol: 0,
    devScore: typeof score === 'number' ? Math.max(0, 100 - score) : 0,
    devLabel: ok ? 'GOOD' : 'BAD',
    timing: liq != null ? `liq $${Number(liq).toFixed(0)}` : '—',
    llm: ok ? 'PASS' : 'FAIL',
    priority: ok ? 80 : 0,
    decision: ok ? 'buy' : 'blocked',
    thesis: ok
      ? `Watchlist mint passed on-chain + RugCheck/GoPlus gates${
          score != null ? ` (score ${score})` : ''
        }.`
      : `Blocked: ${blocker || 'failed safety'}`,
  };
}

export function LiveWatchlistTable({ buyAmount, onBuyAmount, onBuy, mode }: Props) {
  const [watch, setWatch] = useState<WatchMint[]>(() => loadWatchlist());
  const [scans, setScans] = useState<Record<string, WatchlistScanItem>>({});
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mintInput, setMintInput] = useState('');
  const [symInput, setSymInput] = useState('');
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!hasLocalToken()) {
      setErr('Paste GMGN_LOCAL_TOKEN in Credentials to scan the watchlist');
      return;
    }
    const list = loadWatchlist();
    setWatch(list);
    if (list.length === 0) {
      setScans({});
      return;
    }
    setScanning(true);
    setErr(null);
    try {
      const res = await fetchWatchlistScan(list.map((w) => w.mint));
      const map: Record<string, WatchlistScanItem> = {};
      for (const r of res.results || []) map[r.mint] = r;
      setScans(map);
      setScannedAt(res.scannedAt || new Date().toISOString());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, mode]);

  const onAdd = () => {
    const mint = mintInput.trim();
    if (mint.length < 32) {
      setErr('Enter a valid mint address');
      return;
    }
    const next = addWatchMint(mint, symInput || undefined);
    setWatch(next);
    setMintInput('');
    setSymInput('');
    void refresh();
  };

  const onRemove = (mint: string) => {
    setWatch(removeWatchMint(mint));
    setScans((prev) => {
      const n = { ...prev };
      delete n[mint];
      return n;
    });
  };

  const rows = watch.map((w) => toScreenToken(w, scans[w.mint]));

  return (
    <section className={`panel ${scanning ? 'scanning' : ''}`}>
      <div className="mock-data-banner" style={{ borderColor: 'rgba(110,203,255,0.45)', color: '#6ecbff' }}>
        Live watchlist — each row is a real on-chain + RugCheck/GoPlus scan (not mock). Max 8 mints.
        {scannedAt && <> · last scan {new Date(scannedAt).toLocaleTimeString()}</>}
      </div>

      <div className="panel-head">
        <h2>Live Watchlist · {mode}</h2>
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
        <button type="button" className="btn-ghost" onClick={() => void refresh()} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      <div className="watch-add">
        <input
          value={symInput}
          onChange={(e) => setSymInput(e.target.value)}
          placeholder="Symbol (optional)"
          aria-label="Symbol"
        />
        <input
          value={mintInput}
          onChange={(e) => setMintInput(e.target.value)}
          placeholder="Paste Solana mint"
          spellCheck={false}
          autoComplete="off"
          aria-label="Mint address"
        />
        <button type="button" className="btn-primary" onClick={onAdd}>
          Add
        </button>
      </div>

      {err && <div className="cred-msg err">{err}</div>}

      <div className="table-wrap">
        <table className="screen">
          <thead>
            <tr>
              <th>Token</th>
              <th>Mint</th>
              <th>Safety</th>
              <th>Score / Liq</th>
              <th>Decision</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="help">Watchlist empty — add a mint to scan.</div>
                </td>
              </tr>
            )}
            {rows.map((t) => {
              const scan = scans[t.address || ''];
              return (
                <tr key={t.id}>
                  <td>
                    <div className="token-cell">
                      <span className="sym">{t.symbol}</span>
                      <span className="meta">{t.age}</span>
                    </div>
                  </td>
                  <td>
                    <code title={t.address}>{t.mintShort}</code>
                  </td>
                  <td className={t.safeOk ? 'safe-ok' : 'safe-bad'}>{t.safe}</td>
                  <td>
                    {t.timing}
                    {scan?.warnings && scan.warnings.length > 0 && (
                      <div className="help">⚠ {scan.warnings[0]}</div>
                    )}
                  </td>
                  <td>
                    {t.decision === 'buy' ? (
                      <button type="button" className="buy-btn" onClick={() => onBuy(t)}>
                        ⚡ BUY {buyAmount} SOL
                      </button>
                    ) : (
                      <span className="blocked-btn">BLOCKED</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => onRemove(t.address || t.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
