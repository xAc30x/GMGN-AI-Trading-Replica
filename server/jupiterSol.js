/**
 * Jupiter lite-api proxy for Solana ExactIn swaps.
 * Returns quotes and unsigned swap transactions only — never signs.
 */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const JUPITER_BASE = process.env.JUPITER_API_BASE || 'https://lite-api.jup.ag/swap/v1';
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%
export const MAX_SLIPPAGE_BPS = Number(process.env.GMGN_MAX_SLIPPAGE_BPS || 300); // 3%
export const MAX_PRICE_IMPACT_PCT = Number(process.env.GMGN_MAX_PRICE_IMPACT_PCT || 5);

export function solToLamports(human) {
  const s = String(human ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    const err = new Error('Invalid SOL amount');
    err.status = 400;
    throw err;
  }
  const [whole, frac = ''] = s.split('.');
  const frac9 = (frac + '000000000').slice(0, 9);
  return BigInt(whole) * 1_000_000_000n + BigInt(frac9);
}

export function clampSlippageBps(raw) {
  let n = raw == null || raw === '' ? DEFAULT_SLIPPAGE_BPS : Number(raw);
  if (!Number.isFinite(n) || n < 1) n = DEFAULT_SLIPPAGE_BPS;
  n = Math.floor(n);
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
  return jupiterFetch(`/quote?${q}`);
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
  if (raw == null || raw === '') return;
  const n = Number(raw);
  if (!Number.isFinite(n)) return;
  // Jupiter may return fraction (0.01) or percent (1) — treat >1 as percent, else *100
  const pct = Math.abs(n) <= 1 ? Math.abs(n) * 100 : Math.abs(n);
  if (pct > MAX_PRICE_IMPACT_PCT) {
    const err = new Error(
      `Price impact ${pct.toFixed(2)}% exceeds max ${MAX_PRICE_IMPACT_PCT}%`,
    );
    err.status = 400;
    throw err;
  }
}
