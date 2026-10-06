/**
 * Setup checklist shown in Settings: which steps are done, and which step blocks each mode.
 * Pure functions so they can be unit tested. The server and buy flow enforce their own checks.
 */

import type { HealthResponse } from './api';
import type { TradeMode } from './types';

export type StepStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface SetupStep {
  n: number;
  title: string;
  /** Why the step matters, e.g. "needed for PAPER and LIVE". */
  role: string;
  status: StepStatus;
  detail: string;
  /** Modes this step blocks while it fails. */
  blocks: TradeMode[];
}

export interface SetupInput {
  /** null when the server could not be reached. */
  health: HealthResponse | null;
  tokenPresent: boolean;
  walletAddress: string | null;
  walletName: string | null;
  rpcIsPublic: boolean;
}

function short(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function setupSteps({ health, tokenPresent, walletAddress, walletName, rpcIsPublic }: SetupInput): SetupStep[] {
  const gatesStatus: StepStatus = !health ? 'fail' : !health.solLiveEnabled ? 'fail' : !health.solBroadcastEnabled ? 'warn' : 'pass';
  const gatesBlock: TradeMode[] = !health || !health.solLiveEnabled ? ['PAPER', 'LIVE'] : !health.solBroadcastEnabled ? ['LIVE'] : [];
  return [
    {
      n: 1,
      title: 'Local access token',
      role: 'needed for PAPER and LIVE',
      status: tokenPresent ? 'pass' : 'fail',
      detail: tokenPresent ? 'in this browser session' : 'missing',
      blocks: tokenPresent ? [] : ['PAPER', 'LIVE'],
    },
    {
      n: 2,
      title: 'Wallet',
      role: 'signs every LIVE transaction',
      status: walletAddress ? 'pass' : 'fail',
      detail: walletAddress ? `${walletName ?? 'Wallet'} · ${short(walletAddress)}` : 'not connected',
      blocks: walletAddress ? [] : ['LIVE'],
    },
    {
      n: 3,
      title: 'RPC endpoint',
      role: 'reads the chain and sends signed transactions',
      status: health === null ? 'fail' : rpcIsPublic ? 'warn' : 'pass',
      detail: health === null ? 'unknown · server not reachable' : rpcIsPublic ? 'public mainnet' : 'dedicated',
      blocks: [],
    },
    {
      n: 4,
      title: 'Server gates',
      role: 'read-only · change in server env, then restart',
      status: gatesStatus,
      detail: !health
        ? 'server not reachable'
        : !health.solLiveEnabled
          ? 'GMGN_LIVE is off'
          : !health.solBroadcastEnabled
            ? 'broadcast off · LIVE sends disabled'
            : 'market data on · broadcast on',
      blocks: gatesBlock,
    },
    {
      n: 5,
      title: 'Hard limits',
      role: "enforced server-side · the UI can't raise them",
      status: 'info',
      detail: health ? 'reported by the server' : 'unknown',
      blocks: [],
    },
  ];
}

export interface ModeReadiness {
  mode: TradeMode;
  ready: boolean;
  /** Number of the first step that blocks this mode, if any. */
  blockedBy: number | null;
}

/** SHADOW never depends on setup. Other modes are blocked by the first failing step that names them. */
export function modeReadiness(steps: SetupStep[]): ModeReadiness[] {
  return (['SHADOW', 'PAPER', 'LIVE'] as TradeMode[]).map((mode) => {
    const blocker = steps.find((s) => s.blocks.includes(mode));
    return { mode, ready: !blocker, blockedBy: blocker ? blocker.n : null };
  });
}

/** Hard limits the server actually reports. Missing values are left out, never filled in. */
export function limitRows(health: HealthResponse | null): [string, string][] {
  if (!health) return [];
  const rows: [string, string][] = [];
  if (typeof health.maxNativeAmount === 'number') rows.push(['per trade', `${health.maxNativeAmount} SOL`]);
  if (typeof health.maxPortfolioSol === 'number') rows.push(['exposure', `${health.maxPortfolioSol} SOL`]);
  if (typeof health.maxOpenPositions === 'number') rows.push(['open positions', String(health.maxOpenPositions)]);
  if (typeof health.maxSlippageBps === 'number') rows.push(['slippage', `${(health.maxSlippageBps / 100).toFixed(2)}%`]);
  if (typeof health.maxRugScore === 'number') rows.push(['rug score', `≤ ${health.maxRugScore}`]);
  if (typeof health.minLiquidityUsd === 'number') rows.push(['min liquidity', `$${health.minLiquidityUsd.toLocaleString('en-US')}`]);
  if (typeof health.maxPriceImpactPct === 'number') rows.push(['price impact', `${health.maxPriceImpactPct}%`]);
  return rows;
}

export interface SettingsSection {
  id: string;
  label: string;
  /** Setup step numbers shown in this section, in order. */
  steps: number[];
  /** Worst status among its steps: fail, then warn, then pass. 'info' when every step is informational. */
  status: StepStatus;
}

const SECTIONS: Omit<SettingsSection, 'status'>[] = [
  { id: 'access', label: 'Access & wallet', steps: [1, 2] },
  { id: 'network', label: 'Network & RPC', steps: [3] },
  // Safety gates are server rules, not setup steps, so the section has no status of its own.
  { id: 'safety', label: 'Safety gates', steps: [] },
  { id: 'limits', label: 'Trade limits', steps: [5] },
  { id: 'execution', label: 'Execution gates', steps: [4] },
  // Optional display features, off by default; no setup status.
  { id: 'experimental', label: 'Experimental', steps: [] },
];

const RANK: Record<StepStatus, number> = { info: 0, pass: 1, warn: 2, fail: 3 };

/** Groups the setup steps into the settings page sections, each with the status of its worst step. */
export function settingsSections(steps: SetupStep[]): SettingsSection[] {
  return SECTIONS.map((s) => {
    const statuses = steps.filter((st) => s.steps.includes(st.n)).map((st) => st.status);
    const status = statuses.reduce<StepStatus>((worst, st) => (RANK[st] > RANK[worst] ? st : worst), 'info');
    return { ...s, status };
  });
}
