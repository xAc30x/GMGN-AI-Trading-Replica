import { useEffect, useState } from 'react';
import type { HealthResponse } from '../api';
import { fetchHealth, saveCredentials } from '../api';
import { getLocalToken, setLocalToken } from '../localToken';

interface Props {
  open: boolean;
  onClose: () => void;
  onReadyChange?: (ready: boolean, health: HealthResponse | null) => void;
}

function sourceLabel(source?: string, present?: boolean): string {
  if (source === 'disabled') return 'disabled (no server signing)';
  if (!present) return 'missing';
  if (source === 'env') return 'configured via env';
  if (source === 'file') return 'configured via server/.env';
  return 'configured';
}

export function CredentialsPanel({ open, onClose, onReadyChange }: Props) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [wallet, setWallet] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [localToken, setLocalTokenField] = useState(() => getLocalToken());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const h = await fetchHealth();
      setHealth(h);
      onReadyChange?.(h.liveReady, h);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Health check failed — is the server running?');
      onReadyChange?.(false, null);
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  if (!open) return null;

  const c = health?.credentials;

  const onSave = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      if (localToken.trim()) {
        setLocalToken(localToken.trim());
      }
      if (!getLocalToken()) {
        setErr('Paste GMGN_LOCAL_TOKEN from server/.env first (generated on server start).');
        setBusy(false);
        return;
      }
      const body: { walletAddress?: string; apiKey?: string } = {};
      if (wallet.trim()) body.walletAddress = wallet.trim();
      if (apiKey.trim() && c?.apiKeySource === 'missing') body.apiKey = apiKey.trim();
      if (!body.walletAddress && !body.apiKey) {
        setMsg('Local API token stored in this browser session. Wallet/API key unchanged.');
        await refresh();
        return;
      }
      await saveCredentials(body);
      setApiKey('');
      setMsg('Saved to server/.env (chmod 600). Private keys are rejected by this server.');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal credentials-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cred-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span style={{ color: 'var(--lime)' }}>🔑</span>
          <h3 id="cred-title">Quote credentials</h3>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="cred-disclaimer">
          This app <strong>does not</strong> accept or store <code>GMGN_PRIVATE_KEY</code>. Server-side
          LIVE signing is disabled because gmgn-cli cannot hand unsigned txs to your wallet. Configure{' '}
          <code>GMGN_API_KEY</code> and <code>GMGN_WALLET_ADDRESS</code> for quotes only. Prefer
          exporting them in the shell that runs <code>npm run server</code>. Get an API key at{' '}
          <a href="https://gmgn.ai/ai" target="_blank" rel="noreferrer">
            gmgn.ai/ai
          </a>
          . Quotes still need <code>GMGN_LIVE=1</code>, a matching <code>GMGN_LOCAL_TOKEN</code>, and
          stay capped at <code>GMGN_MAX_NATIVE_AMOUNT</code> (default 0.05 native).
        </p>

        <div className="cred-status">
          <div>
            CLI:{' '}
            <strong className={health?.cliInstalled ? 'pos' : 'neg'}>
              {health?.cliInstalled ? 'installed' : 'not found'}
            </strong>
          </div>
          <div>
            API key:{' '}
            <strong className={c?.apiKey ? 'pos' : 'neg'}>
              {sourceLabel(c?.apiKeySource, c?.apiKey)}
            </strong>
          </div>
          <div>
            Private key:{' '}
            <strong className="neg">{sourceLabel(c?.privateKeySource, false)}</strong>
          </div>
          <div>
            Wallet:{' '}
            <strong className={c?.wallet ? 'pos' : 'neg'}>
              {c?.wallet ? c.walletAddressMasked || 'set' : 'missing'}
            </strong>
          </div>
          <div>
            quoteReady:{' '}
            <strong className={health?.liveReady ? 'pos' : 'neg'}>
              {health?.liveReady ? 'yes' : 'no'}
            </strong>
          </div>
          <div>
            server signing:{' '}
            <strong className="neg">
              {health?.serverSigningDisabled !== false ? 'disabled' : 'enabled'}
            </strong>
          </div>
          <div>
            GMGN_LIVE:{' '}
            <strong className={health?.liveEnabled ? 'pos' : 'neg'}>
              {health?.liveEnabled ? '1' : 'off'}
            </strong>
          </div>
          <div>
            max native: <strong>{health?.maxNativeAmount ?? '—'}</strong>
          </div>
          <div>
            browser token:{' '}
            <strong className={getLocalToken() ? 'pos' : 'neg'}>
              {getLocalToken() ? 'in session' : 'missing'}
            </strong>
          </div>
        </div>

        <div className="field">
          <label htmlFor="cred-token">Local API token (GMGN_LOCAL_TOKEN from server/.env)</label>
          <input
            id="cred-token"
            type="password"
            value={localToken}
            onChange={(e) => setLocalTokenField(e.target.value)}
            placeholder="Required for quote / saving wallet or API key"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="cred-wallet">Wallet address (bound to API key)</label>
          <input
            id="cred-wallet"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder={c?.walletAddressMasked || 'Solana / EVM address'}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {c?.apiKeySource === 'missing' && (
          <div className="field">
            <label htmlFor="cred-api">API key (writes server/.env only)</label>
            <input
              id="cred-api"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste only if not already in env"
              autoComplete="off"
            />
          </div>
        )}

        {c?.apiKey && (
          <div className="help" style={{ marginBottom: 12 }}>
            API key is already configured via env/file — no need to paste it into the web UI.
          </div>
        )}

        {msg && <div className="cred-msg ok">{msg}</div>}
        {err && <div className="cred-msg err">{err}</div>}

        <div className="modal-actions">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void onSave()}>
            {busy ? 'Saving…' : 'Save to server'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => void refresh()}>
            Refresh status
          </button>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
