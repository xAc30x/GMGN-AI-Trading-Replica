import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { HealthResponse } from '../api';
import { fetchHealth, saveCredentials } from '../api';
import { getLocalToken, setLocalToken } from '../localToken';
import { ALLOWLISTED_MINTS, safetyRules } from '../safetyRules';
import { MintTest } from './MintTest';
import { limitRows, modeReadiness, settingsSections, setupSteps, type StepStatus } from '../setupChecklist';
import { isPublicSolanaRpc } from '../solana/constants';

interface Props {
  open: boolean;
  onClose: () => void;
  onReadyChange?: (ready: boolean, health: HealthResponse | null) => void;
  /** Experimental live position chart; the same setting as the chart panel's own switch. */
  liveChartOn: boolean;
  onLiveChartChange: (next: boolean) => void;
  /** Closes Settings and starts the first-launch tour again. */
  onReplayTour: () => void;
}

const GLYPH: Record<StepStatus, string> = { pass: '✓', warn: '!', fail: '✕', info: '' };

function sourceLabel(source?: string, present?: boolean): string {
  if (source === 'disabled') return 'disabled (no server signing)';
  if (!present) return 'missing';
  if (source === 'env') return 'configured via env';
  if (source === 'file') return 'configured via server/.env';
  return 'configured';
}

/** Settings as a setup checklist: what is ready, what blocks each mode, and which values the server owns. */
export function CredentialsPanel({ open, onClose, onReadyChange, liveChartOn, onLiveChartChange, onReplayTour }: Props) {
  const wallet = useWallet();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [walletAddr, setWalletAddr] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [tokenPresent, setTokenPresent] = useState(() => Boolean(getLocalToken()));
  const [replacing, setReplacing] = useState(false);
  const [tokenField, setTokenField] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const h = await fetchHealth();
      setHealth(h);
      setErr(null);
      onReadyChange?.(h.liveReady, h);
    } catch (e) {
      setHealth(null);
      setErr(e instanceof Error ? e.message : 'Health check failed — is the server running?');
      onReadyChange?.(false, null);
    } finally {
      setCheckedAt(new Date().toLocaleTimeString());
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  if (!open) return null;

  const c = health?.credentials;
  const rpcIsPublic = Boolean(health?.rpcIsPublic) || isPublicSolanaRpc(import.meta.env.VITE_SOLANA_RPC_URL || '');
  const steps = setupSteps({
    health,
    tokenPresent,
    walletAddress: wallet.publicKey?.toBase58() ?? null,
    walletName: wallet.wallet?.adapter.name ?? null,
    rpcIsPublic,
  });
  const readiness = modeReadiness(steps);
  const sections = settingsSections(steps);
  const limits = limitRows(health);
  const showTokenInput = !tokenPresent || replacing;

  const saveToken = async () => {
    const t = tokenField.trim();
    if (!t) {
      setErr('Paste GMGN_LOCAL_TOKEN from server/.env first (generated on server start).');
      return;
    }
    setLocalToken(t);
    setTokenField('');
    setTokenPresent(true);
    setReplacing(false);
    setMsg('Access token stored in this browser session.');
    await refresh();
  };

  const forgetToken = async () => {
    setLocalToken('');
    setTokenPresent(false);
    setReplacing(false);
    setMsg('Access token removed from this browser session.');
    await refresh();
  };

  const saveLegacy = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      if (!getLocalToken()) {
        setErr('Save the access token first (step 1).');
        return;
      }
      const body: { walletAddress?: string; apiKey?: string } = {};
      if (walletAddr.trim()) body.walletAddress = walletAddr.trim();
      if (apiKey.trim() && c?.apiKeySource === 'missing') body.apiKey = apiKey.trim();
      if (!body.walletAddress && !body.apiKey) {
        setMsg('Nothing to save: wallet address and API key are unchanged.');
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

  const gates: [string, string, boolean][] = health
    ? [
        ['GMGN_LIVE', health.solLiveEnabled ? '1 · market data on' : 'off · PAPER and LIVE blocked', Boolean(health.solLiveEnabled)],
        ['GMGN_SOL_BROADCAST', health.solBroadcastEnabled ? '1 · LIVE sends allowed' : 'unset · no sends', Boolean(health.solBroadcastEnabled)],
        ['server signing', health.serverSigningDisabled === true ? 'disabled ✓' : 'not confirmed disabled', health.serverSigningDisabled === true],
      ]
    : [];

  const jump = (id: string) => {
    setActive(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal credentials-modal settings-page"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cred-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <div className="modal-head">
          <h3 id="cred-title">Setup &amp; credentials</h3>
          <span className="setup-checked">{checkedAt ? `status checked ${checkedAt}` : 'checking status…'}</span>
          <button type="button" className="btn-ghost btn-small" onClick={onReplayTour}>
            Replay tour
          </button>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {sections.map((sec) => (
              <button
                key={sec.id}
                type="button"
                aria-current={active === sec.id ? 'true' : undefined}
                onClick={() => jump(sec.id)}
              >
                <span className={`settings-dot dot-${sec.status}`} aria-hidden="true" />
                {sec.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            <p className="settings-intro">Server-owned values are shown read-only. Edit server/.env and restart the backend.</p>

            <ul className="setup-modes" aria-label="Mode readiness">
              {readiness.map((r) => (
                <li key={r.mode} className={r.ready ? 'is-ready' : 'is-blocked'}>
                  <span className="setup-mode-name">{r.mode}</span>
                  <span>{r.ready ? '✓ Ready' : `✕ Blocked by step ${r.blockedBy}`}</span>
                </li>
              ))}
            </ul>

            {sections.map((sec) => (
              <section key={sec.id} id={`settings-${sec.id}`} className="settings-section" aria-labelledby={`settings-${sec.id}-h`}>
                <h4 id={`settings-${sec.id}-h`}>{sec.label}</h4>
                {sec.id === 'safety' && (
                  <>
                    <p className="setup-note">
                      The server checks these before it builds any LIVE buy or close, and before PAPER entries. If both
                      RugCheck and GoPlus are unavailable, trading fails closed.
                    </p>
                    <div className="rules-wrap">
                      <table className="rules-table" aria-label="Safety rules">
                        <thead>
                          <tr>
                            <th scope="col">Rule</th>
                            <th scope="col">Provider</th>
                            <th scope="col">Threshold</th>
                            <th scope="col">Setting</th>
                            <th scope="col">Effect</th>
                          </tr>
                        </thead>
                        <tbody>
                          {safetyRules(health).map((r) => (
                            <tr key={r.rule}>
                              <th scope="row">{r.rule}</th>
                              <td>{r.provider}</td>
                              <td className="mono">{r.threshold}</td>
                              <td className="mono">{r.setting}</td>
                              <td><span className={`rule-effect effect-${r.effect.toLowerCase()}`}>{r.effect}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="setup-note">
                      Allowlisted mints ({ALLOWLISTED_MINTS.join(', ')}) skip the authority, score, liquidity, largest-holder and
                      GoPlus blocks. The liquidity figure comes from RugCheck, so a nonzero floor blocks while RugCheck is unavailable.
                      Change a setting in <code>server/.env</code>, then restart the backend.
                    </p>
                    <MintTest />
                  </>
                )}
                {sec.id === 'experimental' && (
                  <div className="setup-experimental">
                    <p className="setup-note">Off by default. These may change or break.</p>
                    <label className="experimental-row">
                      <span className="experimental-text">
                        <b>Live position chart (DexScreener)</b>
                        <span>
                          Shows a DexScreener chart for each Solana coin you hold, under Open positions. Display only: it
                          can't place orders, and DexScreener sees which coin you view. Positions and safety checks never
                          depend on it.
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={liveChartOn}
                        onChange={(e) => onLiveChartChange(e.target.checked)}
                        aria-label="Live position chart"
                      />
                    </label>
                  </div>
                )}
                {sec.steps.length > 0 && (
                  <ol className="setup-steps" aria-label={`${sec.label} steps`}>
                    {steps.filter((s) => sec.steps.includes(s.n)).map((s) => (
                      <li key={s.n} className={`setup-step step-${s.status}`}>
                        <span className="setup-badge" aria-label={s.status === 'info' ? `step ${s.n}` : s.status}>
                          {GLYPH[s.status] || s.n}
                        </span>
                        <div className="setup-body">
                          <div className="setup-title">
                            <b>{s.title}</b>
                            <span className="setup-role">{s.role}</span>
                            <span className="setup-detail">{s.detail}</span>
                          </div>

                          {s.n === 1 && (
                            <>
                              {showTokenInput ? (
                                <div className="setup-token">
                                  <input
                                    type="password"
                                    value={tokenField}
                                    onChange={(e) => setTokenField(e.target.value)}
                                    placeholder="Paste GMGN_LOCAL_TOKEN"
                                    autoComplete="off"
                                    aria-label="Local access token"
                                  />
                                  <button type="button" className="btn-primary btn-small" onClick={() => void saveToken()}>
                                    Save token
                                  </button>
                                  {replacing && (
                                    <button type="button" className="btn-ghost btn-small" onClick={() => { setReplacing(false); setTokenField(''); }}>
                                      Cancel
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <div className="setup-actions">
                                  <button type="button" className="btn-ghost btn-small" onClick={() => setReplacing(true)}>
                                    Replace
                                  </button>
                                  <button type="button" className="btn-ghost btn-small" onClick={() => void forgetToken()}>
                                    Forget
                                  </button>
                                </div>
                              )}
                              <code className="setup-cmd">grep GMGN_LOCAL_TOKEN server/.env</code>
                            </>
                          )}

                          {s.n === 2 && (
                            <p className="setup-note">
                              {s.status === 'pass'
                                ? 'This app never holds a private key. Use a throwaway wallet with a small balance.'
                                : 'Connect Phantom or Solflare with the wallet button in the header. This app never holds a private key.'}
                            </p>
                          )}

                          {s.n === 3 && s.status === 'warn' && (
                            <p className="setup-note">
                              Works for smoke tests, unreliable for trading. Set the same dedicated URL for server and browser:{' '}
                              <code>SOLANA_RPC_URL</code> · <code>VITE_SOLANA_RPC_URL</code>
                            </p>
                          )}

                          {s.n === 4 && gates.length > 0 && (
                            <>
                              <dl className="setup-kv">
                                {gates.map(([k, v, ok]) => (
                                  <div key={k}>
                                    <dt>{k}</dt>
                                    <dd className={ok ? 'pos' : 'warn'}>{v}</dd>
                                  </div>
                                ))}
                              </dl>
                              <p className="setup-note">
                                Broadcast is a separate, default-off opt-in. Keeping it off is the safe default; PAPER doesn't need it.
                              </p>
                            </>
                          )}

                          {s.n === 5 && limits.length > 0 && (
                            <dl className="setup-kv setup-limits">
                              {limits.map(([k, v]) => (
                                <div key={k}>
                                  <dt>{k}</dt>
                                  <dd>{v}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}

                {sec.id === 'access' && (
                  <details className="setup-legacy">
                    <summary>Legacy GMGN quote path (non-SOL chains): wallet address, API key. Optional.</summary>
                    <div className="cred-status">
                      <div>
                        CLI: <strong className={health?.cliInstalled ? 'pos' : 'neg'}>{health?.cliInstalled ? 'installed' : 'not found'}</strong>
                      </div>
                      <div>
                        API key: <strong className={c?.apiKey ? 'pos' : 'neg'}>{sourceLabel(c?.apiKeySource, c?.apiKey)}</strong>
                      </div>
                      <div>
                        Wallet: <strong className={c?.wallet ? 'pos' : 'neg'}>{c?.wallet ? c.walletAddressMasked || 'set' : 'missing'}</strong>
                      </div>
                      <div>
                        GMGN quotes: <strong className={health?.liveReady ? 'pos' : 'neg'}>{health?.liveReady ? 'yes' : 'no'}</strong>
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="cred-wallet">Wallet address (legacy GMGN quotes only)</label>
                      <input
                        id="cred-wallet"
                        value={walletAddr}
                        onChange={(e) => setWalletAddr(e.target.value)}
                        placeholder={c?.walletAddressMasked || 'Solana / EVM address'}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    {c?.apiKeySource === 'missing' ? (
                      <div className="field">
                        <label htmlFor="cred-api">GMGN API key (legacy quotes only)</label>
                        <input
                          id="cred-api"
                          type="password"
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          placeholder="Paste only if not already in env"
                          autoComplete="off"
                        />
                      </div>
                    ) : c?.apiKey ? (
                      <p className="setup-note">API key is already configured via env or file. No need to paste it here.</p>
                    ) : null}
                    <button type="button" className="btn-ghost btn-small" disabled={busy} onClick={() => void saveLegacy()}>
                      {busy ? 'Saving…' : 'Save legacy settings'}
                    </button>
                  </details>
                )}
              </section>
            ))}

            {msg && <div className="cred-msg ok">{msg}</div>}
            {err && <div className="cred-msg err">{err}</div>}
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={() => void refresh()}>
            Re-check status
          </button>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <span className="setup-foot">Private keys are rejected by this server.</span>
        </div>
      </div>
    </div>
  );
}
