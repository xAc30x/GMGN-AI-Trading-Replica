import { useState } from 'react';
import { LIVE_SESSION_OPTIONS } from '../livePreflight';
import type { LiveSessionMinutes, PreflightItem, PreflightStatus } from '../livePreflight';

const GLYPH: Record<PreflightStatus, string> = { pass: '✓', warn: '!', fail: '✕' };

interface Props {
  open: boolean;
  /** Mode the user stays in if they cancel. */
  currentMode: string;
  preflight: PreflightItem[];
  onUnlock: (minutes: LiveSessionMinutes) => void;
  onCancel: () => void;
}

/**
 * Explicit, time-boxed opt-in to LIVE. Any failed preflight item blocks the unlock;
 * warnings are shown but do not block. The user must also type LIVE.
 */
export function LiveUnlockDialog({ open, currentMode, preflight, onUnlock, onCancel }: Props) {
  const [confirm, setConfirm] = useState('');
  const [minutes, setMinutes] = useState<LiveSessionMinutes>(30);
  if (!open) return null;

  const failures = preflight.filter((p) => p.status === 'fail');
  const typed = confirm.trim().toUpperCase() === 'LIVE';
  const canUnlock = failures.length === 0 && typed;
  const label = failures.length > 0
    ? `Blocked · ${failures.length} preflight check${failures.length > 1 ? 's' : ''} failed`
    : typed ? `Unlock LIVE for ${minutes} min` : 'Type LIVE to unlock';

  const close = () => {
    setConfirm('');
    onCancel();
  };

  return (
    <div className="modal-backdrop" onClick={close} role="presentation">
      <div
        className="modal unlock-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unlock-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head unlock-head">
          <span className="unlock-dot" aria-hidden />
          <h3 id="unlock-title">Unlock LIVE trading</h3>
          <button type="button" className="x" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        <p className="unlock-intro">
          LIVE spends real SOL. Every buy and close is built by the server, decoded and checked in this browser,
          then shown in your wallet for approval. Prefer PAPER until results look right.
        </p>

        <div className="unlock-section-label">Preflight</div>
        <ul className="preflight-list" aria-label="Preflight checks">
          {preflight.map((p) => (
            <li key={p.label} className={`preflight-${p.status}`}>
              <span className="preflight-glyph" aria-label={p.status}>
                {GLYPH[p.status]}
              </span>
              <span>{p.label}</span>
              <span className="preflight-detail">{p.detail}</span>
            </li>
          ))}
        </ul>

        <div className="unlock-row">
          <span id="unlock-session-label">Auto-lock after</span>
          <div className="unlock-seg" role="group" aria-labelledby="unlock-session-label">
            {LIVE_SESSION_OPTIONS.map((m) => (
              <button key={m} type="button" aria-pressed={minutes === m} onClick={() => setMinutes(m)}>
                {m} min
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="unlock-confirm">
            Type <b className="unlock-word">LIVE</b> to confirm
          </label>
          <input
            id="unlock-confirm"
            className="unlock-input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="LIVE"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn-primary btn-danger unlock-btn"
            disabled={!canUnlock}
            onClick={() => {
              if (!canUnlock) return;
              setConfirm('');
              onUnlock(minutes);
            }}
          >
            {label}
          </button>
          <button type="button" className="btn-ghost" onClick={close}>
            Stay in {currentMode}
          </button>
        </div>
      </div>
    </div>
  );
}
