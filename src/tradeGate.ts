import type { TradeMode } from './types';
import type { Verdict } from './safetyChecks';

/** Preset buy sizes in SOL. Only the ones at or under the server's per-trade limit are offered. */
export const AMOUNT_PRESETS = [0.005, 0.01, 0.025, 0.05] as const;

export interface TradeGateInput {
  mode: TradeMode;
  amount: number;
  /** Server per-trade limit (health.maxNativeAmount); null when the server has not answered. */
  maxNative: number | null;
  /** Full safety checks loaded for this mint. */
  checked: boolean;
  checking: boolean;
  verdict: Verdict | null;
  warningCount: number;
  acknowledged: boolean;
  /** An open position for this mint already exists in the current mode. */
  held: boolean;
  /** Whether `held` is known (PAPER reads it from the server's paper portfolio). */
  heldKnown: boolean;
}

export interface TradeGate {
  can: boolean;
  label: string;
  needsAck: boolean;
}

/**
 * Decides whether the inspector's trade button is enabled and what it says.
 * This is a front door only: the buy dialog, the server and the wallet all re-check.
 */
export function tradeGate(i: TradeGateInput): TradeGate {
  const needsAck = i.verdict === 'REVIEW' && !i.held;
  const block = (label: string): TradeGate => ({ can: false, label, needsAck });

  if (i.mode === 'SHADOW') return block('Switch to PAPER to trade');
  if (i.checking) return block('Checking safety…');
  if (!i.checked || i.verdict === null) return block('Safety checks not loaded');
  if (i.verdict === 'BLOCKED') return block('Blocked · failed safety checks');
  if (!i.heldKnown) return block('Open positions not loaded');
  if (i.held) return block('Already holding · 1 position per mint');
  if (i.maxNative === null) return block('Server limits not loaded');
  if (!Number.isFinite(i.amount) || i.amount <= 0) return block('Choose an amount');
  if (i.amount > i.maxNative) return block(`Amount is above the ${i.maxNative} SOL limit`);
  if (needsAck && !i.acknowledged) {
    return block(`Acknowledge ${i.warningCount > 1 ? `${i.warningCount} warnings` : 'the warning'} to continue`);
  }
  return {
    can: true,
    needsAck,
    label: i.mode === 'PAPER'
      ? `Continue to paper buy · ${i.amount} SOL`
      : `Hold to send to wallet · ${i.amount} SOL`,
  };
}

export type RailTone = 'ok' | 'near' | 'over';

export interface Rail {
  label: string;
  value: string;
  /** 0–100, for the bar width. */
  pct: number;
  tone: RailTone;
}

function rail(label: string, used: number, limit: number, digits: number): Rail {
  const ratio = limit > 0 ? used / limit : 1;
  return {
    label,
    value: `${used.toFixed(digits)} / ${limit.toFixed(digits)}`,
    pct: Math.max(0, Math.min(100, ratio * 100)),
    tone: ratio > 1 ? 'over' : ratio > 0.8 ? 'near' : 'ok',
  };
}

export interface RailsInput {
  mode: TradeMode;
  amount: number;
  maxNative: number | null;
  /** LIVE only: SOL already in open positions this browser knows about. */
  exposureSol: number;
  openPositions: number;
  held: boolean;
  maxPortfolioSol: number | null;
  maxOpenPositions: number | null;
}

/**
 * Hard-limit bars from the server's own limits. LIVE also shows exposure and position count
 * after this trade (estimated from this browser's records; the server re-checks on-chain).
 * PAPER has no portfolio caps on the server, so none are shown.
 */
export function tradeRails(i: RailsInput): Rail[] {
  const rails: Rail[] = [];
  const amount = Number.isFinite(i.amount) && i.amount > 0 ? i.amount : 0;
  if (i.maxNative !== null) rails.push(rail('This trade', amount, i.maxNative, 3));
  if (i.mode === 'LIVE') {
    if (i.maxPortfolioSol !== null) rails.push(rail('Exposure after', i.exposureSol + amount, i.maxPortfolioSol, 3));
    if (i.maxOpenPositions !== null) {
      rails.push(rail('Positions after', i.openPositions + (i.held ? 0 : 1), i.maxOpenPositions, 0));
    }
  }
  return rails;
}
