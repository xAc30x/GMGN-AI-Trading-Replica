import type { Position } from './types.ts';

export const LIVE_POSITIONS_STORAGE_KEY = 'gmgn.positions.v1';
export const TRADE_JOURNAL_STORAGE_KEY = 'gmgn.trades.v1';
const KEY = LIVE_POSITIONS_STORAGE_KEY;
const TRADE_KEY = TRADE_JOURNAL_STORAGE_KEY;
const ACTIVE_STATUSES = new Set(['preparing', 'submitted', 'unknown']);
const RECENT_CONFIRMATION_MS = 120_000;

export interface TradeAttempt {
  id: string;
  fingerprint: string;
  walletAddress: string;
  mint: string;
  symbol?: string;
  side: 'buy' | 'close';
  amountSol: number;
  positionId?: string;
  signature?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  status: 'preparing' | 'submitted' | 'confirmed' | 'failed' | 'unknown';
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PortfolioLimits {
  maxPortfolioSol: number;
  maxOpenPositions: number;
}

export interface PortfolioSnapshot {
  currentExposureSol: number;
  openPositions: number;
  isExistingMint: boolean;
}

function tradeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readPositions(): Position[] {
  return loadLivePositions();
}

function writePositions(positions: Position[]): void {
  saveLivePositions(positions);
}

export function recordLivePosition(positions: Position[], next: Position): Position[] {
  if (next.signature && positions.some(p => !p.demo && p.walletAddress === next.walletAddress &&
    p.address === next.address && (p.tradeSignatures?.includes(next.signature!) || p.signature === next.signature))) {
    return positions;
  }
  // Symbols are labels, never identity. Keep demo state and wallet holdings separate.
  const i = positions.findIndex(p => !p.demo && p.chain === next.chain &&
    p.address === next.address && p.walletAddress === next.walletAddress);
  if (i < 0) return [...positions, {
    ...next,
    tradeSignatures: next.signature ? [next.signature] : [],
  }];
  return positions.map((p, index) => index === i
    ? {
        ...p,
        ...next,
        id: p.id,
        sizeSol: p.sizeSol + next.sizeSol,
        tradeSignatures: [...new Set([...(p.tradeSignatures || (p.signature ? [p.signature] : [])), ...(next.signature ? [next.signature] : [])])],
      }
    : p);
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

export function loadTradeAttempts(): TradeAttempt[] {
  try {
    const value = JSON.parse(localStorage.getItem(TRADE_KEY) || '[]') as TradeAttempt[];
    if (!Array.isArray(value)) return [];
    return value.filter(attempt => attempt && typeof attempt.id === 'string' &&
      typeof attempt.walletAddress === 'string' && typeof attempt.mint === 'string' &&
      ['buy', 'close'].includes(attempt.side) && Number.isFinite(attempt.amountSol) &&
      ['preparing', 'submitted', 'confirmed', 'failed', 'unknown'].includes(attempt.status));
  } catch {
    return [];
  }
}

function saveTradeAttempts(attempts: TradeAttempt[]): void {
  localStorage.setItem(TRADE_KEY, JSON.stringify(attempts));
}

export function updateTradeAttempt(id: string, patch: Partial<TradeAttempt>): TradeAttempt | undefined {
  const attempts = loadTradeAttempts();
  const index = attempts.findIndex(attempt => attempt.id === id);
  if (index < 0) return undefined;
  attempts[index] = { ...attempts[index], ...patch, updatedAt: Date.now() };
  saveTradeAttempts(attempts);
  return attempts[index];
}

function fingerprint(input: Pick<TradeAttempt, 'walletAddress' | 'mint' | 'side' | 'amountSol' | 'positionId'>): string {
  return [input.walletAddress, input.side, input.mint, input.side === 'buy'
    ? input.amountSol.toFixed(9)
    : input.positionId || 'all'].join(':');
}

export async function withWalletTrade<T>(
  input: Omit<TradeAttempt, 'id' | 'fingerprint' | 'status' | 'createdAt' | 'updatedAt'>,
  action: (attempt: TradeAttempt) => Promise<T>,
  limits?: PortfolioLimits,
): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    throw new Error('Cross-tab wallet locking is unavailable; refusing to submit a trade');
  }
  return navigator.locks.request(`gmgn-wallet-${input.walletAddress}`, { mode: 'exclusive' }, async () => {
    const now = Date.now();
    const key = fingerprint(input);
    let attempts = loadTradeAttempts();
    attempts = attempts.map(attempt => attempt.status === 'preparing' && now - attempt.updatedAt > 300_000
      ? { ...attempt, status: 'failed', error: 'Stale unsigned attempt expired', updatedAt: now }
      : attempt);
    const duplicate = attempts.find(attempt => attempt.fingerprint === key && (
      ACTIVE_STATUSES.has(attempt.status) ||
      (attempt.status === 'confirmed' && now - attempt.updatedAt < RECENT_CONFIRMATION_MS)
    ));
    if (duplicate) {
      saveTradeAttempts(attempts);
      throw new Error(duplicate.signature
        ? `Matching trade already has signature ${duplicate.signature}; reconcile before retrying`
        : 'Matching trade is already in progress; reconcile before retrying');
    }
    if (input.side === 'buy' && limits) {
      const blocker = portfolioLimitBlocker({
        walletAddress: input.walletAddress,
        mint: input.mint,
        amountSol: input.amountSol,
        limits,
        positions: readPositions(),
        attempts,
      });
      if (blocker) throw new Error(blocker);
    }
    const attempt: TradeAttempt = {
      ...input,
      id: tradeId(),
      fingerprint: key,
      status: 'preparing',
      createdAt: now,
      updatedAt: now,
    };
    attempts.push(attempt);
    saveTradeAttempts(attempts);
    try {
      const result = await action(attempt);
      const current = loadTradeAttempts().find(item => item.id === attempt.id);
      if (current?.status === 'preparing') updateTradeAttempt(attempt.id, { status: 'confirmed' });
      return result;
    } catch (error) {
      const current = loadTradeAttempts().find(item => item.id === attempt.id);
      if (current?.status === 'preparing') {
        updateTradeAttempt(attempt.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  });
}

export function portfolioLimitBlocker(args: {
  walletAddress: string;
  mint: string;
  amountSol: number;
  limits: PortfolioLimits;
  positions?: Position[];
  attempts?: TradeAttempt[];
}): string | null {
  const snapshot = getPortfolioSnapshot(args.walletAddress, args.mint, args.positions, args.attempts);
  const exposure = snapshot.currentExposureSol;
  if (exposure + args.amountSol > args.limits.maxPortfolioSol + 1e-9) {
    return `Portfolio cap exceeded: ${exposure.toFixed(4)} SOL open/reserved + ${args.amountSol.toFixed(4)} SOL exceeds ${args.limits.maxPortfolioSol} SOL`;
  }
  if (!snapshot.isExistingMint && snapshot.openPositions >= args.limits.maxOpenPositions) {
    return `Open-position cap reached: ${args.limits.maxOpenPositions}`;
  }
  return null;
}

export function getPortfolioSnapshot(
  walletAddress: string,
  mint: string,
  positions: Position[] = readPositions(),
  attempts: TradeAttempt[] = loadTradeAttempts(),
  excludeAttemptId?: string,
): PortfolioSnapshot {
  const walletPositions = positions.filter(position => !position.demo && position.walletAddress === walletAddress);
  const pendingBuys = attempts.filter(attempt => (!excludeAttemptId || attempt.id !== excludeAttemptId) &&
    attempt.walletAddress === walletAddress && attempt.side === 'buy' && ACTIVE_STATUSES.has(attempt.status));
  const openMints = new Set([
    ...walletPositions.map(position => position.address).filter((address): address is string => Boolean(address)),
    ...pendingBuys.map(attempt => attempt.mint),
  ]);
  return {
    currentExposureSol: walletPositions.reduce((sum, position) => sum + position.sizeSol, 0) +
      pendingBuys.reduce((sum, attempt) => sum + attempt.amountSol, 0),
    openPositions: openMints.size,
    isExistingMint: openMints.has(mint),
  };
}

export function addConfirmedBuy(attempt: TradeAttempt): void {
  if (!attempt.signature) return;
  writePositions(recordLivePosition(readPositions(), {
    id: `live-${attempt.signature}`,
    symbol: attempt.symbol || attempt.mint.slice(0, 6),
    address: attempt.mint,
    walletAddress: attempt.walletAddress,
    signature: attempt.signature,
    pnlPct: 0,
    sizeSol: attempt.amountSol,
    entryAge: '0m',
    chain: 'SOL',
    demo: false,
  }));
}

export function removeConfirmedPosition(walletAddress: string, mint: string): void {
  writePositions(readPositions().filter(position =>
    !(position.demo === false && position.walletAddress === walletAddress && position.address === mint)));
}

export async function reconcileWalletTrades(connection: {
  getSignatureStatuses: (signatures: string[], options: { searchTransactionHistory: boolean }) =>
    Promise<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>;
}, walletAddress: string): Promise<TradeAttempt[]> {
  let attempts = loadTradeAttempts();
  const now = Date.now();
  attempts = attempts.map(attempt => attempt.status === 'preparing' && now - attempt.updatedAt > 300_000
    ? { ...attempt, status: 'failed', error: 'Stale unsigned attempt expired', updatedAt: now }
    : attempt);
  saveTradeAttempts(attempts);
  const pending = attempts.filter(attempt => attempt.walletAddress === walletAddress &&
    ['submitted', 'unknown'].includes(attempt.status) && attempt.signature);
  if (pending.length === 0) return attempts;
  const result = await connection.getSignatureStatuses(
    pending.map(attempt => attempt.signature!),
    { searchTransactionHistory: true },
  );
  pending.forEach((attempt, index) => {
    const status = result.value[index];
    if (status?.err) {
      updateTradeAttempt(attempt.id, { status: 'failed', error: JSON.stringify(status.err) });
    } else if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      const confirmed = updateTradeAttempt(attempt.id, { status: 'confirmed', error: undefined });
      if (confirmed?.side === 'buy') addConfirmedBuy(confirmed);
      if (confirmed?.side === 'close') removeConfirmedPosition(confirmed.walletAddress, confirmed.mint);
    }
  });
  return loadTradeAttempts();
}
