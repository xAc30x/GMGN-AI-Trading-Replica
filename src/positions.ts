import type { Position } from './types.ts';

const KEY = 'gmgn.positions.v1';
export function recordLivePosition(positions: Position[], next: Position): Position[] {
  // Symbols are labels, never identity. Keep demo state and wallet holdings separate.
  const i = positions.findIndex(p => !p.demo && p.chain === next.chain &&
    p.address === next.address && p.walletAddress === next.walletAddress);
  if (i < 0) return [...positions, next];
  return positions.map((p, index) => index === i
    ? { ...p, ...next, id: p.id, sizeSol: p.sizeSol + next.sizeSol } : p);
}
export function loadLivePositions(): Position[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]') as Position[];
    if (!Array.isArray(value)) return [];
    return value.filter(p => p && p.demo === false && p.chain === 'SOL' &&
      typeof p.id === 'string' && typeof p.symbol === 'string' &&
      typeof p.address === 'string' && typeof p.walletAddress === 'string' &&
      typeof p.signature === 'string' && Number.isFinite(p.sizeSol) && p.sizeSol > 0);
  } catch { return []; }
}
export function saveLivePositions(positions: Position[]): void {
  localStorage.setItem(KEY, JSON.stringify(positions.filter(p => p.demo === false)));
}
