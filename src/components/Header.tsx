import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import type { Chain, TabId, TradeMode } from '../types';

interface Props {
  tab: TabId;
  onTab: (t: TabId) => void;
  chain: Chain;
  onChain: (c: Chain) => void;
  mode: TradeMode;
  onMode: (m: TradeMode) => void;
  clock: string;
  latency: number;
  liveReady?: boolean;
  onOpenCredentials?: () => void;
}

const CHAINS: Chain[] = ['SOL', 'BSC', 'Base', 'ETH'];

export function Header({
  tab,
  onTab,
  chain,
  onChain,
  mode,
  onMode,
  clock,
  latency,
  liveReady,
  onOpenCredentials,
}: Props) {
  return (
    <header className="header">
      <div className="brand">
        <div className="brand-icon" aria-hidden>
          ⚡
        </div>
        <div>
          <h1>AI TRADER // Screen + One-Click Trade</h1>
          <p>
            v0.0.1 · Safety watchlist + wallet-approved swaps · AI ranking is not implemented
          </p>
        </div>
      </div>

      <nav className="tabs" aria-label="Primary">
        <button
          type="button"
          className={`tab ${tab === 'token' ? 'active' : ''}`}
          onClick={() => onTab('token')}
        >
          Token Screen
        </button>
        <button
          type="button"
          className={`tab ${tab === 'wallet' ? 'active' : ''}`}
          onClick={() => onTab('wallet')}
        >
          Wallet Eval
        </button>
      </nav>

      <div className="header-right">
        <div className="clock" title="UTC clock">
          {clock}
        </div>
        <div className="chip">
          <span className="dot" />
          MCP DEMO
        </div>
        <label className="chip select">
          CHAIN{' '}
          <select
            value={chain}
            onChange={(e) => onChain(e.target.value as Chain)}
            aria-label="Chain"
          >
            {CHAINS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div className="chip">DEMO LAT {latency}ms</div>
        {onOpenCredentials && (
          <button
            type="button"
            className="chip cred-chip"
            onClick={onOpenCredentials}
            title="Quote credentials / local token"
          >
            {liveReady ? '● QUOTE READY' : '○ CREDS'}
          </button>
        )}
        <div className="wallet-btn-wrap">
          <WalletMultiButton />
        </div>
        <button
          type="button"
          className={`mode-btn ${mode === 'LIVE' ? 'live' : ''} ${mode === 'PAPER' ? 'paper' : ''}`}
          onClick={() => {
            const next = mode === 'SHADOW' ? 'PAPER' : mode === 'PAPER' ? 'LIVE' : 'SHADOW';
            onMode(next);
          }}
          title={
            mode === 'LIVE'
              ? 'LIVE: SOL wallet-signed Jupiter (real funds)'
              : mode === 'PAPER'
                ? 'PAPER: quote + rug gate + simulate, no send'
                : 'SHADOW: mock UI only'
          }
        >
          <span className="dot" />
          MODE {mode}
        </button>
        <div className="avatar" title="Demo user">
          ◆
        </div>
      </div>
    </header>
  );
}
