import type { HealthResponse } from '../api';
import { limitsSummary, serverSigning } from '../statusSummary';
import type { LogEntry } from '../types';

interface Props {
  /** Latest entry of the activity log shown for the current mode, if any. */
  lastLog: LogEntry | null;
  health: HealthResponse | null;
}

const SIGNING_TEXT = {
  disabled: 'server signing: disabled',
  enabled: 'server signing: ENABLED',
  unknown: 'server signing: unknown',
} as const;

/** Thin bar along the bottom: the latest activity, the server's hard limits and whether the server signs. */
export function StatusBar({ lastLog, health }: Props) {
  const signing = serverSigning(health);
  return (
    <footer className="status-bar" data-tour="status-bar" aria-label="Status bar">
      <span className="status-last" title={lastLog ? `${lastLog.ts} [${lastLog.category}] ${lastLog.message}` : undefined}>
        {lastLog ? `${lastLog.ts} · ${lastLog.message}` : 'No activity yet this session'}
      </span>
      <span className="status-limits">{limitsSummary(health)}</span>
      <span className={`status-signing status-signing-${signing}`}>{SIGNING_TEXT[signing]}</span>
    </footer>
  );
}
