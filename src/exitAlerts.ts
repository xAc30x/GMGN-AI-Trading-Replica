/**
 * Stop-loss and take-profit alerts for live holdings. Alerts only: the server never holds a key,
 * so nothing sells on its own. A sale always goes through the normal sell flow and the wallet.
 */

export interface ExitRules {
  /** Alert when profit/loss falls to or below this percent (negative). */
  stopLossPct: number;
  /** Alert when profit/loss rises to or above this percent (positive). */
  takeProfitPct: number;
}

/** Same levels the paper model uses, so paper and live are judged the same way. */
export const DEFAULT_EXIT_RULES: ExitRules = Object.freeze({ stopLossPct: -20, takeProfitPct: 30 });
export const STOP_LOSS_RANGE = { min: -95, max: -1 } as const;
export const TAKE_PROFIT_RANGE = { min: 1, max: 1000 } as const;

const inRange = (n: unknown, r: { min: number; max: number }): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= r.min && n <= r.max;

/** Reads saved rules; anything missing or out of range falls back to the default for that field. */
export function parseExitRules(raw: unknown): ExitRules {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    stopLossPct: inRange(value.stopLossPct, STOP_LOSS_RANGE) ? value.stopLossPct : DEFAULT_EXIT_RULES.stopLossPct,
    takeProfitPct: inRange(value.takeProfitPct, TAKE_PROFIT_RANGE) ? value.takeProfitPct : DEFAULT_EXIT_RULES.takeProfitPct,
  };
}

/** The parts of a live valuation the alert needs (see useLivePnl). */
export interface Valuation {
  pnlPct?: number;
  exitValueSol?: number;
  exitStale?: boolean;
  noBalance?: boolean;
  error?: string;
}

export interface ExitAlert {
  kind: 'stop_loss' | 'take_profit';
  pnlPct: number;
  /** True when the level was judged from a sell-now quote rather than a market price estimate. */
  fromQuote: boolean;
  text: string;
}

/** Returns an alert when a fresh valuation has reached a level, otherwise null. */
export function exitAlert(valuation: Valuation | undefined, rules: ExitRules): ExitAlert | null {
  if (!valuation || valuation.error || valuation.noBalance) return null;
  const pnl = valuation.pnlPct;
  if (typeof pnl !== 'number' || !Number.isFinite(pnl)) return null;
  const kind = pnl <= rules.stopLossPct ? 'stop_loss' : pnl >= rules.takeProfitPct ? 'take_profit' : null;
  if (!kind) return null;
  const fromQuote = valuation.exitValueSol != null && !valuation.exitStale;
  const level = kind === 'stop_loss' ? `Stop-loss reached (${rules.stopLossPct}%)` : `Profit target reached (+${rules.takeProfitPct}%)`;
  const basis = fromQuote ? 'sell-now quote' : 'market estimate; the real sale price may be lower';
  return { kind, pnlPct: pnl, fromQuote, text: `${level}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}% by ${basis}.` };
}
