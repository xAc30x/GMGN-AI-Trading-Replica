import type { DiscoveredToken, MintSafetyCheck, WatchlistScanItem } from './api';

/** The token shown in the inspector, with whatever data the list that selected it already had. */
export interface InspectTarget {
  mint: string;
  symbol: string;
  source: 'discover' | 'watchlist';
  discovered?: DiscoveredToken;
  scan?: WatchlistScanItem;
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

/** A failed check blocks. A passed check is a warning when the server marked it as one. */
export function checkStatus(c: MintSafetyCheck): CheckStatus {
  if (!c.ok) return 'fail';
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
