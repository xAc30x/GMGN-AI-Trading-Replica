import { useState } from 'react';

/** Saved on/off choice for the experimental live position chart. Off by default. */
export const LIVE_CHART_STORAGE_KEY = 'gmgn.liveChart.enabled.v1';

/**
 * One shared setting for the chart panel switch and the Settings switch.
 * Falls back to off when storage is unavailable; a blocked write still applies until reload.
 */
export function useLiveChartSetting(): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LIVE_CHART_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const update = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(LIVE_CHART_STORAGE_KEY, String(next));
    } catch {
      // Storage blocked: the choice still applies until the page reloads.
    }
  };
  return [value, update];
}
