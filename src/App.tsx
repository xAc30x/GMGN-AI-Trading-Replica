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
import { SettingsModal } from './components/SettingsModal';
import { WalletEval } from './components/WalletEval';
import { fetchHealth } from './api';
import { signAndSendSolClose } from './solana/sendJupiterSwap';
import { isPublicSolanaRpc } from './solana/constants';
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
  const [positions, setPositions] = useState<Position[]>(INITIAL_POSITIONS);
  const [logs, setLogs] = useState<LogEntry[]>(INITIAL_LOGS);
  const [buyToken, setBuyToken] = useState<ScreenToken | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [credOpen, setCredOpen] = useState(false);
  const [liveReady, setLiveReady] = useState(false);
  const [command, setCommand] = useState(DEFAULT_TRENDING_CMD);
  const [pollInterval, setPollInterval] = useState(5.6);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      setClock(utcClock());
      setLatency(140 + Math.floor(Math.random() * 120));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void fetchHealth()
      .then((h) => setLiveReady(h.liveReady))
      .catch(() => setLiveReady(false));
  }, []);

  const awaiting = tokens.filter((t) => t.decision === 'buy').length;
  const exposure = useMemo(
    () => positions.reduce((s, p) => s + p.sizeSol, 0),
    [positions],
  );
  const escapeAlerts = positions.filter((p) => p.alert || p.pnlPct < -10).length;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

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
        if (h.rpcIsPublic || isPublicSolanaRpc()) {
          showToast('Using public Solana RPC — set VITE_SOLANA_RPC_URL for reliability');
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
          ? 'Mode PAPER — simulate only (no send). Screening table remains mock.'
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
        if (prev.some((p) => p.symbol === token.symbol)) {
          return prev.map((p) =>
            p.symbol === token.symbol ? { ...p, sizeSol: p.sizeSol + amount } : p,
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
      setPositions((prev) => {
        if (prev.some((p) => p.symbol === token.symbol)) {
          return prev.map((p) =>
            p.symbol === token.symbol
              ? {
                  ...p,
                  sizeSol: p.sizeSol + amount,
                  address: meta.tokenAddress || p.address,
                  chain,
                  demo: false,
                }
              : p,
          );
        }
        return [
          ...prev,
          {
            id: `p${Date.now()}`,
            symbol: token.symbol,
            address: meta.tokenAddress,
            pnlPct: 0,
            sizeSol: amount,
            entryAge: '0m',
            chain,
            demo: false,
          },
        ];
      });
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

    if (mode === 'LIVE') {
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
        setPositions((prev) => prev.filter((p) => p.id !== id));
        appendLog(
          'SELL',
          'live',
          `SOL wallet close ${pos.symbol} · tx ${res.signature.slice(0, 10)}…`,
        );
        showToast(`Closed · ${res.signature.slice(0, 12)}…`);
      } catch (e) {
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
        onChain={setChain}
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
              <MetricCards
                scanned={tokens.length}
                pastSafety={tokens.filter((t) => t.safeOk).length}
                blockedSafety={tokens.filter((t) => !t.safeOk).length}
                pastConsensus={tokens.filter((t) => t.llm !== 'FAIL').length}
                blockedConsensus={tokens.filter((t) => t.llm === 'FAIL').length}
                awaiting={awaiting}
                positions={positions.length}
                cap={20}
                exposure={exposure}
                escapeAlerts={escapeAlerts}
                trapRate={100}
              />
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
                <LiveWatchlistTable
                  buyAmount={buyAmount}
                  onBuyAmount={setBuyAmount}
                  onBuy={setBuyToken}
                  mode={mode}
                />
              )}
              <DecisionLog logs={logs} />
            </div>
            <div className="col-side">
              <PositionEscapeMonitor positions={positions} onClose={(id) => void handleClosePosition(id)} />
              <GateFunnel
                scanned={tokens.length}
                pending={awaiting}
                exposure={exposure}
                positions={positions.length}
                cap={20}
              />
            </div>
          </div>
        ) : (
          <WalletEval />
        )}
      </main>

      <BuyModal
        token={buyToken}
        amount={buyAmount}
        mode={mode}
        chain={chain}
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
