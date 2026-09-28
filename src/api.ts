/** Thin client for the local GMGN quote backend. Secrets never touch the browser. */

import { getLocalToken } from './localToken';

export interface HealthResponse {
  ok: boolean;
  cliInstalled: boolean;
  liveEnabled?: boolean;
  tokenConfigured?: boolean;
  maxNativeAmount?: number;
  maxPortfolioSol?: number;
  maxOpenPositions?: number;
  /** Always true in this build — server never signs LIVE swaps. */
  serverSigningDisabled?: boolean;
  credentials: {
    apiKey: boolean;
    privateKey: boolean;
    wallet: boolean;
    walletAddressMasked?: string;
    apiKeySource?: string;
    privateKeySource?: string;
  };
  /** Quote-ready (API key + wallet + GMGN_LIVE + local token). Not a signing ready flag. */
  liveReady: boolean;
  solLiveEnabled?: boolean;
  solBroadcastEnabled?: boolean;
  solWalletTrading?: boolean;
  maxSlippageBps?: number;
  defaultSlippageBps?: number;
  maxPriceImpactPct?: number;
  mintSafetyRequired?: boolean;
  paperModeSupported?: boolean;
  rpcIsPublic?: boolean;
  solanaRpcConfigured?: boolean;
}


export interface QuoteResponse {
  ok: boolean;
  error?: string;
  outputAmount?: string;
  minOutputAmount?: string;
  slippage?: number;
  quote?: Record<string, unknown>;
  amountSmallest?: string;
}

export interface SwapResponse {
  ok: boolean;
  error?: string;
  orderId?: string;
  hash?: string;
  status?: string;
  explorerUrl?: string | null;
  data?: Record<string, unknown>;
  serverSigningDisabled?: boolean;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getLocalToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token && url !== '/api/health') {
    headers['X-GMGN-Token'] = token;
  }
  const res = await fetch(url, {
    ...init,
    headers,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return body;
}

export function fetchHealth(): Promise<HealthResponse> {
  return jsonFetch('/api/health');
}

export function saveCredentials(body: {
  walletAddress?: string;
  apiKey?: string;
}): Promise<{ ok: boolean; credentials: HealthResponse['credentials'] }> {
  return jsonFetch('/api/credentials', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function fetchQuote(body: {
  chain: string;
  inputToken?: string;
  outputToken: string;
  amount?: number;
  amountSmallest?: string;
  slippage?: number;
}): Promise<QuoteResponse> {
  return jsonFetch('/api/quote', { method: 'POST', body: JSON.stringify(body) });
}

/** @deprecated Server returns 410 — signing disabled. Kept for type compat only. */
export function postSwap(_body: {
  chain: string;
  inputToken?: string;
  outputToken: string;
  amount?: number;
  amountSmallest?: string;
  slippage?: number;
  autoSlippage?: boolean;
  antiMev?: boolean;
  confirm: true;
  mode: 'LIVE';
}): Promise<SwapResponse> {
  return jsonFetch('/api/swap', { method: 'POST', body: JSON.stringify(_body) });
}

export function fetchOrder(chain: string, orderId: string): Promise<SwapResponse> {
  const q = new URLSearchParams({ chain, orderId });
  return jsonFetch(`/api/order?${q}`);
}

/** @deprecated Server returns 410 — signing disabled. */
export function postClose(body: {
  chain: string;
  tokenAddress: string;
  percent?: number;
  confirm: true;
  mode: 'LIVE';
  autoSlippage?: boolean;
}): Promise<SwapResponse> {
  return jsonFetch('/api/close', { method: 'POST', body: JSON.stringify(body) });
}

export function explorerBase(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'sol') return 'https://solscan.io/tx/';
  if (c === 'bsc') return 'https://bscscan.com/tx/';
  if (c === 'base') return 'https://basescan.org/tx/';
  if (c === 'eth') return 'https://etherscan.io/tx/';
  return '';
}

export function buildTradeIntent(args: {
  chain: string;
  outputToken: string;
  amount: number;
  outputAmount?: string;
  minOutputAmount?: string;
  slippage?: number;
}): string {
  return [
    'GMGN trade intent (NOT signed by this app)',
    `chain: ${args.chain}`,
    `outputToken: ${args.outputToken}`,
    `amountNative: ${args.amount}`,
    args.outputAmount != null ? `estOutput: ${args.outputAmount}` : null,
    args.minOutputAmount != null ? `minOutput: ${args.minOutputAmount}` : null,
    args.slippage != null ? `quoteSlippagePct: ${args.slippage}` : null,
    'Complete this trade in a wallet you control (e.g. https://gmgn.ai).',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function pollOrder(
  chain: string,
  orderId: string,
  times = 4,
  gapMs = 2500,
): Promise<SwapResponse> {
  let last: SwapResponse = { ok: false };
  for (let i = 0; i < times; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
    try {
      last = await fetchOrder(chain, orderId);
      const s = (last.status || '').toLowerCase();
      if (s === 'confirmed' || s === 'failed' || s === 'expired' || s === 'successful') {
        return last;
      }
    } catch (e) {
      last = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return last;
}

export interface SolQuoteResponse {
  ok: boolean;
  error?: string;
  amountLamports?: string;
  slippageBps?: number;
  outAmount?: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
  quote?: Record<string, unknown>;
  outputMint?: string;
}

export interface SolSwapTxResponse {
  ok: boolean;
  error?: string;
  swapTransaction: string;
  lastValidBlockHeight?: number;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  outputMint?: string;
}

export function fetchSolQuote(body: {
  outputMint: string;
  amount?: number;
  amountLamports?: string;
  slippageBps?: number;
}): Promise<SolQuoteResponse> {
  return jsonFetch('/api/sol/quote', { method: 'POST', body: JSON.stringify(body) });
}

export function fetchSolSwapTx(body: {
  outputMint: string;
  amount?: number;
  amountLamports?: string;
  slippageBps?: number;
  userPublicKey: string;
  tradeId: string;
  quote?: Record<string, unknown>;
  confirm: true;
  mode: 'LIVE' | 'PAPER';
}): Promise<SolSwapTxResponse> {
  return jsonFetch('/api/sol/swap-tx', { method: 'POST', body: JSON.stringify(body) });
}

export interface MintSafetyCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface MintSafetyResponse {
  ok: boolean;
  mint: string;
  checks: MintSafetyCheck[];
  blockers: string[];
  warnings?: string[];
  decimals?: number;
  supply?: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  error?: string;
  rug?: {
    ok: boolean;
    warnings?: string[];
    blockers?: string[];
    rugcheck?: {
      score?: number;
      scoreNormalised?: number;
      rugged?: boolean;
      totalMarketLiquidity?: number;
      totalHolders?: number;
    } | null;
  };
}

export function fetchMintSafety(mint: string): Promise<MintSafetyResponse> {
  return jsonFetch('/api/sol/mint-safety', {
    method: 'POST',
    body: JSON.stringify({ mint }),
  });
}

export function fetchSolCloseTx(body: {
  inputMint: string;
  amountAtomic?: string;
  balanceAtomic?: string;
  percent?: number;
  slippageBps?: number;
  userPublicKey: string;
  confirm: true;
  mode: 'LIVE';
}): Promise<SolSwapTxResponse> {
  return jsonFetch('/api/sol/close-tx', { method: 'POST', body: JSON.stringify(body) });
}

export interface WatchlistScanItem {
  mint: string;
  ok: boolean;
  blockers: string[];
  warnings?: string[];
  checks: MintSafetyCheck[];
  decimals?: number;
  supply?: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  error?: string;
  rug?: MintSafetyResponse['rug'];
}

export interface WatchlistScanResponse {
  ok: boolean;
  results: WatchlistScanItem[];
  scannedAt?: string;
  error?: string;
}

export function fetchWatchlistScan(mints: string[]): Promise<WatchlistScanResponse> {
  return jsonFetch('/api/sol/watchlist-scan', {
    method: 'POST',
    body: JSON.stringify({ mints }),
  });
}
