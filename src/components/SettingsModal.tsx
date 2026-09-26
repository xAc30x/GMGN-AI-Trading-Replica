import { useState } from 'react';
import { DEFAULT_TRENDING_CMD } from '../data/mockData';

interface Props {
  open: boolean;
  command: string;
  interval: number;
  onClose: () => void;
  onSave: (command: string, interval: number) => void;
}

export function SettingsModal({ open, command, interval, onClose, onSave }: Props) {
  const [cmd, setCmd] = useState(command);
  const [iv, setIv] = useState(String(interval));

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span style={{ color: 'var(--lime)' }}>⚙</span>
          <h3 id="settings-title">Screening Settings • Trending Command / Poll</h3>
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => {
              setCmd(DEFAULT_TRENDING_CMD);
              setIv('5.6');
            }}
          >
            ↺ Reset
          </button>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="field">
          <label htmlFor="trending-cmd">GMGN-CLI trending command</label>
          <textarea
            id="trending-cmd"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            spellCheck={false}
          />
          <div className="help">
            Reference command only. This screen does not execute commands or fetch trending data.
          </div>
        </div>

        <div className="field">
          <label htmlFor="poll-iv">Poll interval (seconds)</label>
          <div className="inline-input">
            <input
              id="poll-iv"
              type="number"
              min={1}
              step={0.1}
              value={iv}
              onChange={(e) => setIv(e.target.value)}
            />
            <span style={{ color: 'var(--text-dim)' }}>s</span>
          </div>
          <div className="help">
            Demo setting only. The live watchlist refreshes when opened or when you select Rescan.
          </div>
        </div>

        <div className="warn-box">
          Saving starts a mock scan animation. The backend supports quotes and safety checks, but no trending command or polling endpoint.
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => onSave(cmd, Number(iv) || 5.6)}
          >
            Save & apply now
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setCmd(DEFAULT_TRENDING_CMD)}
          >
            Restore default command
          </button>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <span className="modal-status">
            Trending execution is not implemented
          </span>
        </div>
      </div>
    </div>
  );
}
