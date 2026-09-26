/**
 * Jupiter lite-api proxy for Solana ExactIn swaps.
 * Returns quotes and unsigned swap transactions only — never signs.
 */
import { envNumber } from './config.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const JUPITER_BASE = process.env.JUPITER_API_BASE || 'https://lite-api.jup.ag/swap/v1';
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%
export const MAX_SLIPPAGE_BPS = envNumber('GMGN_MAX_SLIPPAGE_BPS', 300, { min: 1, max: 10000, integer: true }); // 3%
export const MAX_PRICE_IMPACT_PCT = envNumber('GMGN_MAX_PRICE_IMPACT_PCT', 5, { min: 0, max: 100 });

export function solToLamports(human) {
  const s = String(human ?? '').trim();
  if (!/^\d+(\.\d{1,9})?$/.test(s)) {
    const err = new Error('Invalid SOL amount');
    err.status = 400;
    throw err;
  }
  const [whole, frac = ''] = s.split('.');
  const frac9 = (frac + '000000000').slice(0, 9);
  return BigInt(whole) * 1_000_000_000n + BigInt(frac9);
}

export function clampSlippageBps(raw) {
  const n = raw == null || raw === '' ? Math.min(DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS) : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw Object.assign(new Error('Invalid slippageBps'), { status: 400 });
  }
  if (n > MAX_SLIPPAGE_BPS) {
    const err = new Error(`slippageBps exceeds max ${MAX_SLIPPAGE_BPS}`);
    err.status = 400;
    throw err;
  }
  return n;
}

async function jupiterFetch(path, { method = 'GET', body } = {}) {
  const url = `${JUPITER_BASE}${path}`;
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(12000),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 400) };
  }
  if (!res.ok) {
    const err = new Error(data.error || data.message || `Jupiter HTTP ${res.status}`);
    err.status = 502;
    err.details = data;
    throw err;
  }
  return data;
}

export async function getQuote({
  inputMint = SOL_MINT,
  outputMint,
  amountAtomic,
  slippageBps,
}) {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountAtomic),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });
  const quote = await jupiterFetch('/quote?' + q);
  assertQuoteMatches(quote, { inputMint, outputMint, amountAtomic, slippageBps });
  return quote;
}

/** @deprecated use getQuote */
export async function getQuoteBuy({ outputMint, amountLamports, slippageBps }) {
  return getQuote({
    inputMint: SOL_MINT,
    outputMint,
    amountAtomic: amountLamports,
    slippageBps,
  });
}

export async function getSwapTransaction({ quoteResponse, userPublicKey }) {
  return jupiterFetch('/swap', {
    method: 'POST',
    body: {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    },
  });
}

export function assertPriceImpactOk(quote) {
  const raw = quote?.priceImpactPct;
  if (typeof raw !== 'string' || !/^-?\d+(\.\d+)?$/.test(raw)) {
    throw Object.assign(new Error('Missing or invalid price impact'), { status: 502 });
  }
  // Jupiter Swap V1 reports a fraction: 0.01 = 1%, 1 = 100%.
  const pct = Math.abs(Number(raw)) * 100;
  if (!Number.isFinite(pct) || pct > MAX_PRICE_IMPACT_PCT) {
    throw Object.assign(new Error('Price impact exceeds max ' + MAX_PRICE_IMPACT_PCT + '%'), { status: 400 });
  }
}

export function assertQuoteMatches(quote, intent) {
  const atomic = (v) => typeof v === 'string' && /^[0-9]+$/.test(v) && BigInt(v) > 0n;
  if (!quote || quote.inputMint !== intent.inputMint || quote.outputMint !== intent.outputMint ||
      quote.swapMode !== 'ExactIn' || !atomic(quote.inAmount) ||
      !atomic(quote.outAmount) || !atomic(quote.otherAmountThreshold) ||
      BigInt(quote.inAmount) !== BigInt(intent.amountAtomic) ||
      quote.slippageBps !== intent.slippageBps ||
      BigInt(quote.otherAmountThreshold) > BigInt(quote.outAmount) ||
      BigInt(quote.otherAmountThreshold) <
        BigInt(quote.outAmount) * BigInt(10000 - intent.slippageBps) / 10000n ||
      !Array.isArray(quote.routePlan) || quote.routePlan.length === 0) {
    throw Object.assign(new Error('Jupiter quote does not match trade intent'), { status: 502 });
  }
  assertPriceImpactOk(quote);
}
