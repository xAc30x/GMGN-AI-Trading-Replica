import type { SolQuoteResponse } from './api';

/**
 * Formats an atomic token amount (a base-10 integer string) with the mint's decimals, without floating-point loss.
 * Digits beyond `maxFraction` are cut (not rounded); pass 9 for SOL so lamport fees stay exact.
 */
export function formatAtomic(raw: string | undefined, decimals: number | undefined, maxFraction = 6): string | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0) return `${BigInt(raw).toLocaleString('en-US')} units`;
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString('en-US');
  const frac = (value % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
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

/** The checked transaction facts reported by the signing code (mirrors CheckedSwap in solana/sendJupiterSwap.ts). */
export interface CheckedFacts {
  inputAmount: string;
  minimumOutput: string;
  slippageBps: number;
  priorityFeeLamports: string;
  transactionFeeLamports: number;
}

/**
 * Rows describing the real transaction after it passed the local checks, shown while the wallet prompt is open.
 * Fees are listed separately as reported; they are not added together.
 */
export function checkedRows(facts: CheckedFacts, symbol: string, decimals: number | undefined): PreviewRow[] {
  const rows: PreviewRow[] = [];
  const sent = formatAtomic(facts.inputAmount, 9, 9);
  if (sent) rows.push({ label: 'You send', value: `${sent} SOL` });
  const min = formatAtomic(facts.minimumOutput, decimals);
  if (min) rows.push({ label: 'Minimum receive', value: `≥ ${min} ${symbol}` });
  rows.push({ label: 'Slippage limit', value: `${(facts.slippageBps / 100).toFixed(2)}%` });
  const base = Number.isSafeInteger(facts.transactionFeeLamports) && facts.transactionFeeLamports >= 0
    ? formatAtomic(String(facts.transactionFeeLamports), 9, 9)
    : null;
  if (base) rows.push({ label: 'Network fee (RPC estimate)', value: `${base} SOL` });
  const priority = formatAtomic(facts.priorityFeeLamports, 9, 9);
  if (priority) rows.push({ label: 'Priority fee (in transaction)', value: `${priority} SOL` });
  return rows;
}
