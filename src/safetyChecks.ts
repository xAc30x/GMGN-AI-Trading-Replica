import type { DiscoveredToken, MintSafetyCheck, WatchlistScanItem } from './api';
import type { ScreenToken } from './types';

/** The token shown in the inspector, with whatever data the list that selected it already had. */
export interface InspectTarget {
  mint: string;
  symbol: string;
  source: 'discover' | 'watchlist';
  discovered?: DiscoveredToken;
  scan?: WatchlistScanItem;
  /** What the existing buy dialog needs, built by the list the row came from. */
  buyToken: ScreenToken;
}

export type CheckStatus = 'pass' | 'warn' | 'fail';
export type CheckGroupId = 'onchain' | 'rugcheck' | 'goplus' | 'other';
export type Verdict = 'PASS' | 'REVIEW' | 'BLOCKED';

export interface GroupedCheck extends MintSafetyCheck {
  status: CheckStatus;
}

export interface CheckGroup {
  id: CheckGroupId;
  label: string;
  checks: GroupedCheck[];
}

const GROUP_LABELS: Record<CheckGroupId, string> = {
  onchain: 'On-chain',
  rugcheck: 'RugCheck',
  goplus: 'GoPlus',
  other: 'Other',
};

const ONCHAIN_IDS = new Set(['format', 'exists', 'spl', 'program', 'parse', 'rpc', 'freezeAuthority', 'mintAuthority', 'decimals', 'supply']);
const RUGCHECK_IDS = new Set(['rugcheck', 'rugScan', 'rugged', 'rugScore', 'liquidity', 'topHolder']);

/** Which provider produced a check, based on the ids the server uses (server/mintSafety.js, server/rugScanner.js). */
export function checkGroup(id: string): CheckGroupId {
  if (ONCHAIN_IDS.has(id)) return 'onchain';
  if (RUGCHECK_IDS.has(id) || id.startsWith('risk:')) return 'rugcheck';
  if (id === 'goplus' || id.startsWith('goplus:')) return 'goplus';
  return 'other';
}

/**
 * A failed check blocks, except one the server itself rates only a warning (a single rug provider
 * being unavailable; the server blocks only when both are down). A passed check is a warning when
 * the server marked it as one.
 */
export function checkStatus(c: MintSafetyCheck): CheckStatus {
  if (!c.ok) return c.level === 'warn' ? 'warn' : 'fail';
  if (c.level === 'warn' || /^warn:/i.test(c.detail)) return 'warn';
  return 'pass';
}

/** Groups checks by provider in a fixed order, keeping the server's order inside each group. Empty groups are left out. */
export function groupChecks(checks: MintSafetyCheck[]): CheckGroup[] {
  const order: CheckGroupId[] = ['onchain', 'rugcheck', 'goplus', 'other'];
  const byGroup = new Map<CheckGroupId, GroupedCheck[]>(order.map((g) => [g, []]));
  for (const c of checks) byGroup.get(checkGroup(c.id))!.push({ ...c, status: checkStatus(c) });
  return order
    .map((id) => ({ id, label: GROUP_LABELS[id], checks: byGroup.get(id)! }))
    .filter((g) => g.checks.length > 0);
}

export function countStatuses(checks: MintSafetyCheck[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[checkStatus(c)] += 1;
  return counts;
}

/**
 * BLOCKED when the server says the mint is not ok or lists a blocker,
 * REVIEW when anything warns, otherwise PASS.
 */
export function safetyVerdict(input: {
  ok: boolean;
  blockers?: string[];
  warnings?: string[];
  checks?: MintSafetyCheck[];
}): Verdict {
  if (!input.ok || (input.blockers?.length ?? 0) > 0) return 'BLOCKED';
  const anyWarn = (input.warnings?.length ?? 0) > 0 || (input.checks ?? []).some((c) => checkStatus(c) !== 'pass');
  return anyWarn ? 'REVIEW' : 'PASS';
}

const SHORT_LABELS: Record<string, string> = {
  format: 'format', exists: 'exists', spl: 'SPL', program: 'program', parse: 'parse', rpc: 'RPC',
  freezeAuthority: 'freeze', mintAuthority: 'mint auth', decimals: 'decimals', supply: 'supply',
  rugcheck: 'provider', rugScan: 'scan', rugged: 'rugged', rugScore: 'score', liquidity: 'liquidity',
  topHolder: 'top holder', risk: 'risks', goplus: 'provider',
};

/** RugCheck's named risks vary per token, so the matrix folds them into one "risks" column. */
function matrixColumnId(id: string): string {
  return id.startsWith('risk:') ? 'risk' : id;
}

export interface MatrixColumn {
  id: string;
  group: CheckGroupId;
  label: string;
}

export interface MatrixRow {
  mint: string;
  symbol: string;
  /** Worst status per column; missing when that check did not run for this token. */
  cells: Record<string, CheckStatus>;
  verdict: Verdict;
  checkCount: number;
}

export interface WhyItem {
  mint: string;
  symbol: string;
  group: string;
  status: CheckStatus;
  detail: string;
}

const RANK: Record<CheckStatus, number> = { pass: 0, warn: 1, fail: 2 };

/**
 * Every check for every scanned token in one table. Columns are the union of checks the server
 * actually ran, in provider order; nothing is invented for checks that did not run.
 */
export function buildMatrix(items: { mint: string; symbol: string; scan: WatchlistScanItem }[]): {
  columns: MatrixColumn[];
  rows: MatrixRow[];
  why: WhyItem[];
} {
  const order: CheckGroupId[] = ['onchain', 'rugcheck', 'goplus', 'other'];
  const seen = new Map<string, MatrixColumn>();
  const rows: MatrixRow[] = [];
  const why: WhyItem[] = [];
  for (const { mint, symbol, scan } of items) {
    const cells: Record<string, CheckStatus> = {};
    for (const c of scan.checks) {
      const col = matrixColumnId(c.id);
      const group = checkGroup(c.id);
      if (!seen.has(col)) {
        seen.set(col, { id: col, group, label: SHORT_LABELS[col] ?? col.replace(/^goplus:/, '').replace(/_/g, ' ') });
      }
      const status = checkStatus(c);
      if (!(col in cells) || RANK[status] > RANK[cells[col]]) cells[col] = status;
      if (status !== 'pass') {
        why.push({ mint, symbol, group: GROUP_LABELS[group], status, detail: c.detail.replace(/^warn:\s*/i, '') });
      }
    }
    rows.push({ mint, symbol, cells, verdict: safetyVerdict(scan), checkCount: scan.checks.length });
  }
  const columns = [...seen.values()].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  why.sort((a, b) => RANK[b.status] - RANK[a.status]);
  return { columns, rows, why };
}
