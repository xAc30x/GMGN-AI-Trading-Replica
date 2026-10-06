import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import type { Chain, TabId, TradeMode } from '../types';

/** What we know about the RPC endpoint. `unknown` until the server answers. */
export type RpcKind = 'public' | 'dedicated' | 'unknown';

interface Props {
  tab: TabId;
  onTab: (t: TabId) => void;
  chain: Chain;
  onChain: (c: Chain) => void;
  mode: TradeMode;
  onMode: (m: TradeMode) => void;
  clock: string;
  rpc: RpcKind;
  onOpenSettings?: () => void;
}

const CHAINS: Chain[] = ['SOL', 'BSC', 'Base', 'ETH'];
const MODES: TradeMode[] = ['SHADOW', 'PAPER', 'LIVE'];

const MODE_TITLES: Record<TradeMode, string> = {
  SHADOW: 'SHADOW: mock data and intents only',
  PAPER: 'PAPER: fresh quotes and safety checks, virtual funds, nothing sent',
  LIVE: 'LIVE: real funds, your wallet approves every transaction',
};

const RPC_LABELS: Record<RpcKind, { text: string; title: string }> = {
  public: { text: 'PUBLIC RPC', title: 'Public Solana RPC: fine for smoke tests, unreliable for trading. Set SOLANA_RPC_URL and VITE_SOLANA_RPC_URL.' },
  dedicated: { text: 'DEDICATED RPC', title: 'A dedicated Solana RPC URL is configured.' },
  unknown: { text: 'RPC ?', title: 'Server status not available yet.' },
};

export function Header({ tab, onTab, chain, onChain, mode, onMode, clock, rpc, onOpenSettings }: Props) {
  const rpcLabel = RPC_LABELS[rpc];
  return (
    <header className="header">
      <div className="brand">
        <div className="brand-icon" aria-hidden>
          AI
        </div>
        <div>
          <h1>AI Trader</h1>
          <p>Solana · rules-based screening · wallet-signed swaps</p>
        </div>
      </div>

      <nav className="tabs" aria-label="Primary">
        <button
          type="button"
          className={`tab ${tab === 'token' ? 'active' : ''}`}
          aria-current={tab === 'token' ? 'page' : undefined}
          onClick={() => onTab('token')}
        >
          Trade
        </button>
        <button
          type="button"
          className={`tab ${tab === 'research' ? 'active' : ''}`}
          aria-current={tab === 'research' ? 'page' : undefined}
          onClick={() => onTab('research')}
        >
          Research
        </button>
        <button
          type="button"
          className={`tab ${tab === 'wallet' ? 'active' : ''}`}
          aria-current={tab === 'wallet' ? 'page' : undefined}
          onClick={() => onTab('wallet')}
        >
          Wallet eval
        </button>
      </nav>

      <div className="header-right">
        <div className="clock" title="UTC clock">
          {clock}
        </div>
        <span className={`chip rpc-chip rpc-${rpc}`} title={rpcLabel.title}>
          <span className="dot" aria-hidden />
          {rpcLabel.text}
        </span>
        <label className="chip select">
          CHAIN{' '}
          <select value={chain} onChange={(e) => onChain(e.target.value as Chain)} aria-label="Chain">
            {CHAINS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div className="wallet-btn-wrap">
          <WalletMultiButton />
        </div>
        <div className="mode-switch" role="group" aria-label="Trading mode">
          {MODES.map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                className={`mode-opt mode-opt-${m.toLowerCase()} ${active ? 'active' : ''}`}
                aria-pressed={active}
                title={MODE_TITLES[m]}
                onClick={() => {
                  if (!active) onMode(m);
                }}
              >
                {m === 'LIVE' && !active ? 'LIVE ⊘' : m}
              </button>
            );
          })}
        </div>
        {onOpenSettings && (
          <button type="button" className="header-btn" onClick={onOpenSettings}>
            Settings
          </button>
        )}
      </div>
    </header>
  );
}
