/** Compact US dollar amount: $1.2K, $3.4M, $5.6B. Missing values show as an em dash. */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Token age from minutes: 42m, 5h, 3d. */
export function age(m: number | null | undefined): string {
  if (m == null) return '—';
  if (m < 60) return `${m}m`;
  if (m < 60 * 48) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/** A market cap older than this is no longer shown as the current one. */
export const MARKET_CAP_FRESH_MS = 45000;

/**
 * Market cap when a position was opened next to the latest one, e.g. "MC $120.0K → $135.0K (+12.5%)".
 * Returns null when neither is known. An out-of-date latest value is shown as unknown, not as current.
 */
export function marketCapView(
  entryUsd: number | null | undefined,
  latest: { usd: number; at: number } | null | undefined,
  now: number,
): { text: string; tone: 'pos' | 'neg' | null } | null {
  const entry = entryUsd != null && Number.isFinite(entryUsd) && entryUsd > 0 ? entryUsd : null;
  const current = latest && Number.isFinite(latest.usd) && latest.usd > 0 && now - latest.at <= MARKET_CAP_FRESH_MS
    ? latest.usd : null;
  if (entry === null && current === null) return null;
  if (current === null) return { text: `MC at buy ${usd(entry)} · now unknown`, tone: null };
  if (entry === null) return { text: `MC now ${usd(current)}`, tone: null };
  const change = (current - entry) / entry * 100;
  return {
    text: `MC ${usd(entry)} → ${usd(current)} (${change > 0 ? '+' : ''}${change.toFixed(1)}%)`,
    tone: change > 0 ? 'pos' : change < 0 ? 'neg' : null,
  };
}
