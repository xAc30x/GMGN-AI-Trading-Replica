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
