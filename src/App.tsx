import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { LiveBuyMeta } from './components/BuyModal';
import { BuyModal } from './components/BuyModal';
import { CredentialsPanel } from './components/CredentialsPanel';
import { DecisionLog } from './components/DecisionLog';
import { DemoBanner } from './components/DemoBanner';
import { GateFunnel } from './components/GateFunnel';
import { Header } from './components/Header';
import { MetricCards } from './components/MetricCards';
import { PositionEscapeMonitor } from './components/PositionEscapeMonitor';
import { ScreeningTable } from './components/ScreeningTable';
import { LiveWatchlistTable } from './components/LiveWatchlistTable';
import { DiscoveryFeed } from './components/DiscoveryFeed';
import { useLivePnl } from './useLivePnl';
import { addWatchMint } from './watchlist';
import { SettingsModal } from './components/SettingsModal';
import { WalletEval } from './components/WalletEval';
import {
  loadLivePositions,
  reconcileWalletTrades,
  LIVE_POSITIONS_STORAGE_KEY,
} from './positions';
import { fetchHealth } from './api';
import { signAndSendSolClose } from './solana/sendJupiterSwap';
import { isPublicSolanaRpc, makeConnection } from './solana/constants';
import { hasLocalToken } from './localToken';
import {
  DEFAULT_TRENDING_CMD,
  INITIAL_LOGS,
  INITIAL_POSITIONS,
  INITIAL_TOKENS,
} from './data/mockData';
import type { Chain, LogEntry, Position, ScreenToken, TabId, TradeMode } from './types';

function utcClock(): string {
  const d = new Date();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}Z`;
}

function nowTs(): string {
  return utcClock();
}

export default function App() {
  const wallet = useWallet();
  const [tab, setTab] = useState<TabId>('token');
  const [chain, setChain] = useState<Chain>('SOL');
  const [mode, setMode] = useState<TradeMode>('SHADOW');
  const [clock, setClock] = useState(utcClock);
  const [latency, setLatency] = useState(233);
  const [buyAmount, setBuyAmount] = useState(0.01);
  const [tokens] = useState<ScreenToken[]>(INITIAL_TOKENS);
  const [positions, setPositions] = useState<Position[]>(() => [...INITIAL_POSITIONS, ...loadLivePositions()]);
  const [logs, setLogs] = useState<LogEntry[]>(INITIAL_LOGS);
  const [buyToken, setBuyToken] = useState<ScreenToken | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [credOpen, setCredOpen] = useState(false);
  const [liveReady, setLiveReady] = useState(false);
  const [command, setCommand] = useState(DEFAULT_TRENDING_CMD);
  const [pollInterval, setPollInterval] = useState(5.6);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const reconcileTrades = useCallback(async () => {
    if (!wallet.publicKey) return;
    try {
      const walletAddress = wallet.publicKey.toBase58();
      const attempts = await reconcileWalletTrades(makeConnection(), walletAddress);
      setPositions([...INITIAL_POSITIONS, ...loadLivePositions()]);
      const unresolved = attempts.filter(attempt => attempt.walletAddress === walletAddress &&
        (attempt.status === 'submitted' || attempt.status === 'unknown'));
      if (unresolved.length > 0) {
        showToast(`${unresolved.length} trade signature(s) remain unresolved; reconcile before retrying`);
      }
    } catch {
      showToast('Trade reconciliation unavailable; pending signatures remain reserved');
    }
  }, [wallet.publicKey, showToast]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setClock(utcClock());
      setLatency(140 + Math.floor(Math.random() * 120));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void fetchHealth()
      .then((h) => {
        setLiveReady(h.liveReady);
      })
      .catch(() => setLiveReady(false));
  }, []);

  useEffect(() => {
    const syncStoredTrades = (event: StorageEvent) => {
      if (event.key && event.key !== LIVE_POSITIONS_STORAGE_KEY) return;
      setPositions([...INITIAL_POSITIONS, ...loadLivePositions()]);
    };
    window.addEventListener('storage', syncStoredTrades);
    return () => window.removeEventListener('storage', syncStoredTrades);
  }, []);

  useEffect(() => {
    void reconcileTrades();
    const onFocus = () => { void reconcileTrades(); };
    const onVisible = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reconcileTrades]);

  const visiblePositions = positions.filter(p => mode === 'SHADOW'
    ? p.demo
    : !p.demo && p.walletAddress === wallet.publicKey?.toBase58());
  const [watchVersion, setWatchVersion] = useState(0);
  const { pnl: livePnl, refreshing: pnlRefreshing } = useLivePnl(visiblePositions, wallet.publicKey, mode !== 'SHADOW' && chain === 'SOL');
  const trackedPositions = visiblePositions.filter(p => (livePnl[p.id]?.zeroStreak ?? 0) < 2);
  const awaiting = tokens.filter((t) => t.decision === 'buy').length;
  const exposure = useMemo(
    () => visiblePositions.reduce((s, p) => s + p.sizeSol, 0),
    [visiblePositions],
  );
  const escapeAlerts = visiblePositions.filter((p) => p.demo && (p.alert || p.pnlPct < -10)).length;

  const appendLog = useCallback((kind: LogEntry['kind'], category: string, message: string) => {
    setLogs((prev) => [
      ...prev,
      {
        id: `l${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ts: nowTs(),
        kind,
        category,
        message,
      },
    ]);
  }, []);

  const handleMode = async (m: TradeMode) => {
    if (m === 'LIVE' || m === 'PAPER') {
      if (!hasLocalToken()) {
        showToast('Paste GMGN_LOCAL_TOKEN from server/.env in Credentials');
        setCredOpen(true);
        return;
      }
      try {
        const h = await fetchHealth();
        setLiveReady(h.liveReady);
        const solLive = Boolean(h.solLiveEnabled ?? h.liveEnabled);
        if (!solLive) {
          showToast('Server LIVE flag off — export GMGN_LIVE=1 then restart npm run server');
          return;
        }
        if (m === 'LIVE' && chain === 'SOL' && !h.solBroadcastEnabled) {
          showToast('SOL transaction broadcast is disabled — PAPER remains available without it');
          return;
        }
        if (h.rpcIsPublic || isPublicSolanaRpc(import.meta.env.VITE_SOLANA_RPC_URL || '')) {
          showToast('Using public Solana RPC (via local proxy) — set SOLANA_RPC_URL for reliability');
        }
      } catch {
        showToast('Server not reachable — start npm run server');
        return;
      }
      if (chain === 'SOL' && !wallet.connected) {
        showToast('Connect Phantom or Solflare first (needed as fee-payer pubkey)');
        return;
      }
      if (m === 'LIVE') {
        const ok = window.confirm(
          chain === 'SOL'
            ? 'SOL LIVE spends real funds after wallet approve. Prefer PAPER first. Continue?'
            : 'LIVE on this chain is quote/intent only. Continue?',
        );
        if (!ok) return;
      } else {
        const ok = window.confirm(
          'PAPER mode: real quotes + rug checks + RPC simulate. Nothing is signed or sent. Continue?',
        );
        if (!ok) return;
      }
    }
    setMode(m);
    const msg =
      m === 'LIVE'
        ? chain === 'SOL'
          ? 'Mode LIVE — wallet-signed SOL Jupiter.'
          : 'Mode LIVE — quote/intent only on this chain.'
        : m === 'PAPER'
          ? 'Mode PAPER — simulate only (no send). Discovery and watchlist use live screening.'
          : 'Mode SHADOW (mock UI only).';
    appendLog('SCREEN', 'mode', msg);
  };

  const handleBuyConfirm = (token: ScreenToken, amount: number, meta?: LiveBuyMeta) => {
    if (!meta?.live) {
      setBuyToken(null);
      const tag = 'SHADOW intent';
      appendLog(
        'BUY',
        'shadow',
        `${tag}: ${token.symbol} · ${amount} ${chain} · intent only (no SL/TP orders).`,
      );
      setPositions((prev) => {
        if (prev.some((p) => p.demo && p.chain === chain && p.symbol === token.symbol)) {
          return prev.map((p) =>
            p.demo && p.chain === chain && p.symbol === token.symbol ? { ...p, sizeSol: p.sizeSol + amount } : p,
          );
        }
        return [
          ...prev,
          {
            id: `p${Date.now()}`,
            symbol: token.symbol,
            pnlPct: 0,
            sizeSol: amount,
            entryAge: '0m',
            chain,
            demo: true,
          },
        ];
      });
      showToast(`${tag} recorded for ${token.symbol}`);
      return;
    }

    if (meta.paper) {
      appendLog(
        'BUY',
        'paper',
        `PAPER sim ok: ${token.symbol} · ${amount} SOL · CA ${meta.tokenAddress.slice(0, 8)}… (not sent)`,
      );
      showToast('PAPER simulation recorded — nothing sent on-chain');
      return;
    }

    if (meta.walletSigned) {
      appendLog(
        'BUY',
        'live',
        `SOL wallet swap: ${token.symbol} · ${amount} SOL · tx ${meta.hash?.slice(0, 10) || '?'}…`,
      );
      setPositions([...INITIAL_POSITIONS, ...loadLivePositions()]);
      showToast(meta.hash ? `Wallet swap landed · ${meta.hash.slice(0, 12)}…` : 'Wallet swap submitted');
      window.setTimeout(() => setBuyToken(null), 1200);
      return;
    }

    appendLog(
      'BUY',
      'live',
      meta.intentOnly
        ? `LIVE intent copied: ${token.symbol} · ${amount} ${chain} · CA ${meta.tokenAddress.slice(0, 8)}… (not signed here)`
        : `LIVE note: ${token.symbol} · ${amount} ${chain}`,
    );
    showToast('Intent recorded — complete the trade in your wallet / gmgn.ai');
  };

  const handleClosePosition = async (id: string) => {
    const pos = positions.find((p) => p.id === id);
    if (!pos) return;

    if (mode !== 'LIVE' && !pos.demo) {
      showToast('Live holdings can only be closed in LIVE with wallet approval.');
      return;
    }
    if (mode === 'LIVE') {
      if (pos.walletAddress !== wallet.publicKey?.toBase58()) {
        showToast('Connect the wallet that owns this position.');
        return;
      }
      if (chain !== 'SOL' || (pos.chain && pos.chain !== 'SOL')) {
        showToast('Wallet-signed close is SOL-only. Switch chain to SOL or close in your wallet.');
        return;
      }
      if (pos.demo || !pos.address) {
        showToast('Demo / SHADOW positions cannot be LIVE-closed');
        return;
      }
      if (!wallet.connected || !wallet.publicKey) {
        showToast('Connect Phantom or Solflare to close');
        return;
      }
      if (!hasLocalToken()) {
        showToast('Paste GMGN_LOCAL_TOKEN in Credentials first');
        setCredOpen(true);
        return;
      }
      const ok = window.confirm(
        `SOL LIVE close ${pos.symbol}: sell 100% of this mint in your connected wallet via Jupiter? Your wallet must approve.`,
      );
      if (!ok) return;
      try {
        const res = await signAndSendSolClose({
          wallet,
          inputMint: pos.address,
          percent: 100,
          slippageBps: 100,
        });
        setPositions([...INITIAL_POSITIONS, ...loadLivePositions()]);
        appendLog(
          'SELL',
          'live',
          `SOL wallet close ${pos.symbol} · tx ${res.signature.slice(0, 10)}…`,
        );
        showToast(`Closed · ${res.signature.slice(0, 12)}…`);
      } catch (e) {
        setPositions([...INITIAL_POSITIONS, ...loadLivePositions()]);
        void reconcileTrades();
        showToast(e instanceof Error ? e.message : 'SOL close failed');
      }
      return;
    }

    setPositions((prev) => prev.filter((p) => p.id !== id));
    appendLog(
      'SELL',
      'shadow',
      `Closed ${pos.symbol} @ ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(1)}% · ${pos.sizeSol} ${chain}`,
    );
  };

  const handleSaveSettings = (cmd: string, iv: number) => {
    setCommand(cmd);
    setPollInterval(iv);
    setSettingsOpen(false);
    setScanning(true);
    appendLog('SCREEN', 'settings', `Poll interval set to ${iv}s · mock scan started.`);
    window.setTimeout(() => {
      setScanning(false);
      appendLog('SCREEN', 'scan', `Mock scan complete · ${tokens.length} tokens refreshed.`);
      showToast('Mock scan applied');
    }, 1600);
  };

  return (
    <div className="app-shell">
      <DemoBanner />
      <Header
        tab={tab}
        onTab={setTab}
        chain={chain}
        onChain={(next) => { setChain(next); setMode('SHADOW'); setBuyToken(null); }}
        mode={mode}
        onMode={(m) => void handleMode(m)}
        clock={clock}
        latency={latency}
        liveReady={liveReady}
        onOpenCredentials={() => setCredOpen(true)}
      />

      <main className="main">
        {tab === 'token' ? (
          <div className="token-layout">
            <div className="col-main">
              {mode === 'SHADOW' && <MetricCards
                scanned={tokens.length}
                pastSafety={tokens.filter((t) => t.safeOk).length}
                blockedSafety={tokens.filter((t) => !t.safeOk).length}
                pastConsensus={tokens.filter((t) => t.llm !== 'FAIL').length}
                blockedConsensus={tokens.filter((t) => t.llm === 'FAIL').length}
                awaiting={awaiting}
                positions={visiblePositions.length}
                cap={20}
                exposure={exposure}
                escapeAlerts={escapeAlerts}
                trapRate={100}
              />}
              {mode === 'SHADOW' ? (
                <ScreeningTable
                  tokens={tokens}
                  buyAmount={buyAmount}
                  onBuyAmount={setBuyAmount}
                  onBuy={setBuyToken}
                  onOpenSettings={() => setSettingsOpen(true)}
                  scanning={scanning}
                  mode={mode}
                />
              ) : (
                <>
                  {chain === 'SOL' && <DiscoveryFeed
                    buyAmount={buyAmount}
                    mode={mode}
                    onBuy={setBuyToken}
                    onWatch={(mint, symbol) => {
                      try {
                        addWatchMint(mint, symbol);
                        setWatchVersion(v => v + 1);
                        showToast(`Added ${symbol || mint.slice(0, 6)} to watchlist`);
                      } catch { showToast('Watchlist storage unavailable'); }
                    }}
                  />}
                  <LiveWatchlistTable
                    key={watchVersion}
                    buyAmount={buyAmount}
                    onBuyAmount={setBuyAmount}
                    onBuy={setBuyToken}
                    mode={mode}
                  />
                </>
              )}
              <DecisionLog logs={mode === 'SHADOW' ? logs : logs.filter(l => l.category === 'live' || l.category === 'paper')} />
            </div>
            <div className="col-side">
              <PositionEscapeMonitor positions={trackedPositions} livePnl={livePnl} refreshing={pnlRefreshing} onClose={(id) => void handleClosePosition(id)} />
              {mode === 'SHADOW' && <GateFunnel
                scanned={tokens.length}
                pending={awaiting}
                exposure={exposure}
                positions={visiblePositions.length}
                cap={20}
              />}
            </div>
          </div>
        ) : (
          <WalletEval />
        )}
      </main>

      <BuyModal
        key={String(buyToken?.id) + mode + chain}
        token={buyToken}
        amount={buyAmount}
        mode={mode}
        chain={chain}
        onReconcile={() => { void reconcileTrades(); }}
        onClose={() => setBuyToken(null)}
        onConfirm={handleBuyConfirm}
      />
      <CredentialsPanel
        open={credOpen}
        onClose={() => setCredOpen(false)}
        onReadyChange={(ready) => setLiveReady(ready)}
      />
      <SettingsModal
        open={settingsOpen}
        command={command}
        interval={pollInterval}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
      />
      {toast && <div className="scan-toast">{toast}</div>}
    </div>
  );
}
