import type { HealthResponse } from './api';

function trim(n: number): string {
  return String(Number(n.toFixed(6)));
}

/** One-line summary of the server's hard limits, read from /api/health. Never filled in with defaults. */
export function limitsSummary(health: HealthResponse | null): string {
  if (!health) return 'limits: server status not loaded';
  const parts: string[] = [];
  if (typeof health.maxNativeAmount === 'number') parts.push(`${trim(health.maxNativeAmount)} SOL/trade`);
  if (typeof health.maxPortfolioSol === 'number') parts.push(`${trim(health.maxPortfolioSol)} SOL total`);
  if (typeof health.maxOpenPositions === 'number') {
    parts.push(`${health.maxOpenPositions} position${health.maxOpenPositions === 1 ? '' : 's'}`);
  }
  if (typeof health.maxSlippageBps === 'number') parts.push(`${trim(health.maxSlippageBps / 100)}% slippage`);
  if (health.mintSafetyRequired === true) parts.push('scans fail-closed');
  return parts.length > 0 ? `limits ${parts.join(' · ')}` : 'limits: not reported by server';
}

export type SigningState = 'disabled' | 'enabled' | 'unknown';

/** The server must never sign; anything other than an explicit `true` is not reported as disabled. */
export function serverSigning(health: HealthResponse | null): SigningState {
  if (health?.serverSigningDisabled === true) return 'disabled';
  if (health?.serverSigningDisabled === false) return 'enabled';
  return 'unknown';
}
