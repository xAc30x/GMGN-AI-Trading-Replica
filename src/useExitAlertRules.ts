import { useState } from 'react';
import { parseExitRules, type ExitRules } from './exitAlerts';

/** Saved stop-loss / take-profit alert levels for live holdings, kept in this browser. */
export const EXIT_RULES_STORAGE_KEY = 'gmgn.exitAlertRules.v1';

/** Falls back to the defaults when storage is unavailable; a blocked write still applies until reload. */
export function useExitAlertRules(): [ExitRules, (next: ExitRules) => void] {
  const [rules, setRules] = useState<ExitRules>(() => {
    try {
      return parseExitRules(JSON.parse(localStorage.getItem(EXIT_RULES_STORAGE_KEY) || 'null'));
    } catch {
      return parseExitRules(null);
    }
  });
  const update = (next: ExitRules) => {
    const valid = parseExitRules(next);
    setRules(valid);
    try {
      localStorage.setItem(EXIT_RULES_STORAGE_KEY, JSON.stringify(valid));
    } catch {
      // Storage blocked: the levels still apply until the page reloads.
    }
  };
  return [rules, update];
}
