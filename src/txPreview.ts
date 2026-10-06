import type { SolQuoteResponse } from './api';

/** Formats an atomic token amount (a base-10 integer string) with the mint's decimals, without floating-point loss. */
export function formatAtomic(raw: string | undefined, decimals: number | undefined): string | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0) return `${BigInt(raw).toLocaleString('en-US')} units`;
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString('en-US');
  const frac = (value % base).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export interface PreviewRow {
  label: string;
  value: string;
}

/**
 * What the LIVE buy is expected to look like, from a fresh quote. The real transaction is built
 * by the server and checked in this browser only when you hold the button; this is an estimate.
 */
export function quotePreview(input: {
  amountSol: number;
  symbol: string;
  decimals: number | undefined;
  quote: SolQuoteResponse;
  slippageBps: number;
}): PreviewRow[] {
  const { amountSol, symbol, decimals, quote, slippageBps } = input;
  const rows: PreviewRow[] = [{ label: 'You send', value: `${amountSol} SOL` }];
  const out = formatAtomic(quote.outAmount, decimals);
  if (out) rows.push({ label: 'Estimated receive', value: `${out} ${symbol}` });
  const min = formatAtomic(quote.otherAmountThreshold, decimals);
  if (min) rows.push({ label: 'Minimum receive', value: `≥ ${min} ${symbol}` });
  rows.push({ label: 'Slippage limit', value: `${(slippageBps / 100).toFixed(2)}%` });
  const impact = Number(quote.priceImpactPct);
  if (quote.priceImpactPct != null && Number.isFinite(impact)) {
    rows.push({ label: 'Price impact', value: `${(impact * 100).toFixed(2)}%` });
  }
  return rows;
}

/** What validateSwapTransaction.js checks on the real transaction before the wallet is asked to sign. */
export const CHECKED_BEFORE_WALLET = [
  'Exactly one Jupiter exact-in route',
  'Your wallet is the only signer and fee payer',
  'No extra transfers or unknown programs',
  'Network fee within the policy limit',
] as const;
