/** Mark-to-market PnL against the SOL spent on the swap (excludes one-time account rent and fees). */
export function computePnl(sizeSol: number, outLamports: string | number): { valueSol: number; pnlPct: number } {
  const valueSol = Number(outLamports) / 1e9;
  const pnlPct = sizeSol > 0 ? ((valueSol - sizeSol) / sizeSol) * 100 : 0;
  return { valueSol, pnlPct };
}

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

/** Reject incomplete RPC data instead of treating it as an empty wallet. */
export function readTokenBalance(accounts: unknown[], owner: string, mint: string): { atomic: string; tokenAmount: number } {
  if (!Array.isArray(accounts)) throw new Error('Invalid wallet balances');
  let amount = 0n;
  let decimals: number | undefined;
  for (const entry of accounts) {
    const info = (entry as { account?: { data?: { parsed?: { info?: {
      owner?: string; mint?: string; tokenAmount?: { amount?: string; decimals?: number }
    } } } } })?.account?.data?.parsed?.info;
    const token = info?.tokenAmount;
    if (info?.owner !== owner || info?.mint !== mint || !token || typeof token.amount !== 'string' ||
        !/^\d+$/.test(token.amount) || !Number.isInteger(token.decimals) || token.decimals! < 0 || token.decimals! > 255 ||
        (decimals !== undefined && decimals !== token.decimals)) throw new Error('Invalid wallet token account');
    amount += BigInt(token.amount);
    decimals = token.decimals;
  }
  const tokenAmount = Number(amount) / 10 ** (decimals ?? 0);
  if (!Number.isFinite(tokenAmount)) throw new Error('Invalid wallet token amount');
  return { atomic: amount.toString(), tokenAmount };
}

/** A paper mark older than this no longer counts as the current value (matches the server's equity rule). */
export const PAPER_MARK_FRESH_MS = 45000;

export interface PaperMarkView {
  /** Main text, e.g. "+3.21%" or "Price out of date". */
  text: string;
  /** Second line: SOL gain or loss, current value and age, or the last known result. */
  detail: string;
  /** Colour hint: up, down, or neither (flat, missing or out of date). */
  tone: 'pos' | 'neg' | null;
}

const signed = (n: number, digits: number) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;

/**
 * How an open paper position is doing, from the server's latest sell quote (net of fees).
 * Out-of-date marks show the last known result without a colour, so they are not mistaken for live.
 */
export function paperMarkView(
  mark: { at: number; netLamports: string; pnlPct: number } | null,
  costLamports: string,
  lastError: string | null,
  now: number,
): PaperMarkView {
  if (!mark) return { text: 'Waiting for first price', detail: lastError ?? 'The server checks prices about every 15s', tone: null };
  const age = formatAgo(now - mark.at);
  if (lastError || now - mark.at > PAPER_MARK_FRESH_MS) {
    return { text: 'Price out of date', detail: `Last ${signed(mark.pnlPct, 2)}% · ${age}`, tone: null };
  }
  const valueSol = Number(mark.netLamports) / 1e9;
  const gainSol = Number(BigInt(mark.netLamports) - BigInt(costLamports)) / 1e9;
  return {
    text: `${signed(mark.pnlPct, 2)}%`,
    detail: `${signed(gainSol, 6)} SOL · worth ${valueSol.toFixed(6)} SOL · ${age}`,
    tone: mark.pnlPct > 0 ? 'pos' : mark.pnlPct < 0 ? 'neg' : null,
  };
}
