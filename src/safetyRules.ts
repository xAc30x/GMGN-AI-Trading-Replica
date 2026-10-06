/**
 * The safety rules the server applies before a trade, as shown in Settings → Safety gates.
 * Written from server/mintSafety.js, server/rugScanner.js and server/jupiterSol.js. Thresholds the
 * server reports in /api/health come from there; fixed rules say so. Nothing here enforces anything.
 */

import type { HealthResponse } from './api';

export type RuleEffect = 'BLOCK' | 'WARN';

export interface SafetyRule {
  rule: string;
  provider: 'On-chain' | 'RugCheck' | 'GoPlus' | 'Jupiter' | 'RugCheck + GoPlus';
  threshold: string;
  /** The server env variable that changes it, or 'fixed' when it is set in code. */
  setting: string;
  effect: RuleEffect;
}

/** Mints that skip the authority, score, liquidity, top-holder and GoPlus blocks (server allowlist). */
export const ALLOWLISTED_MINTS = ['USDC', 'USDT', 'wSOL'] as const;

const UNKNOWN = 'unknown · server not reachable';

function reported(health: HealthResponse | null, value: number | undefined, format: (n: number) => string): string {
  if (!health) return UNKNOWN;
  return typeof value === 'number' && Number.isFinite(value) ? format(value) : 'not reported';
}

export function safetyRules(health: HealthResponse | null): SafetyRule[] {
  const liquidity = reported(health, health?.minLiquidityUsd, (n) =>
    n > 0 ? `≥ $${n.toLocaleString('en-US')}` : 'off (set to 0)',
  );
  return [
    { rule: 'Valid SPL or Token-2022 mint', provider: 'On-chain', threshold: 'required', setting: 'fixed', effect: 'BLOCK' },
    { rule: 'Freeze authority revoked', provider: 'On-chain', threshold: 'required', setting: 'fixed', effect: 'BLOCK' },
    { rule: 'Decimals and supply readable', provider: 'On-chain', threshold: 'decimals 0–18 · supply > 0', setting: 'fixed', effect: 'BLOCK' },
    { rule: 'Mint authority still active', provider: 'On-chain', threshold: 'reported', setting: 'fixed', effect: 'WARN' },
    { rule: 'Marked rugged', provider: 'RugCheck', threshold: 'must be false', setting: 'fixed', effect: 'BLOCK' },
    {
      rule: 'Normalised risk score',
      provider: 'RugCheck',
      threshold: reported(health, health?.maxRugScore, (n) => `≤ ${n}`),
      setting: 'GMGN_MAX_RUG_SCORE',
      effect: 'BLOCK',
    },
    { rule: 'Danger-level risks', provider: 'RugCheck', threshold: 'none', setting: 'fixed', effect: 'BLOCK' },
    { rule: 'Warn-level risks', provider: 'RugCheck', threshold: 'reported', setting: 'fixed', effect: 'WARN' },
    { rule: 'Market liquidity', provider: 'RugCheck', threshold: liquidity, setting: 'GMGN_MIN_LIQUIDITY_USD', effect: 'BLOCK' },
    { rule: 'Largest holder', provider: 'RugCheck', threshold: 'under 40% · data required', setting: 'fixed', effect: 'BLOCK' },
    { rule: 'Non-transferable, closable or transfer hook', provider: 'GoPlus', threshold: 'none', setting: 'fixed', effect: 'BLOCK' },
    { rule: 'Freezable by authority', provider: 'GoPlus', threshold: 'must be false', setting: 'fixed', effect: 'BLOCK' },
    { rule: 'Mintable', provider: 'GoPlus', threshold: 'reported', setting: 'fixed', effect: 'WARN' },
    {
      rule: 'Price impact on the quote',
      provider: 'Jupiter',
      threshold: reported(health, health?.maxPriceImpactPct, (n) => `≤ ${n}%`),
      setting: 'GMGN_MAX_PRICE_IMPACT_PCT',
      effect: 'BLOCK',
    },
    { rule: 'One scanner unavailable', provider: 'RugCheck + GoPlus', threshold: 'reported', setting: 'fixed', effect: 'WARN' },
    { rule: 'Both scanners unavailable', provider: 'RugCheck + GoPlus', threshold: 'fail closed', setting: 'fixed', effect: 'BLOCK' },
  ];
}
