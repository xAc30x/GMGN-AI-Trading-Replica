/** Thin client for the local GMGN quote backend. Secrets never touch the browser. */

import { noteSignInRequired } from './auth';
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
  maxRugScore?: number;
  minLiquidityUsd?: number;
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
    noteSignInRequired(res.status, body);
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
  /** Severity from the rug scanners ('info' | 'warn' | 'danger' or a provider level). On-chain checks omit it. */
  level?: string;
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
  tradeId: string;
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

export interface SolReclaimTxResponse {
  ok: boolean;
  error?: string;
  transaction: string;
  lastValidBlockHeight: number;
  accounts: { address: string; program: string; lamports: number }[];
  refundLamports: string;
}

/** Unsigned close of the wallet's empty token accounts for one coin; the rent returns to the wallet. */
export function fetchSolReclaimTx(body: {
  tradeId: string;
  mint: string;
  userPublicKey: string;
  confirm: true;
  mode: 'LIVE';
}): Promise<SolReclaimTxResponse> {
  return jsonFetch('/api/sol/reclaim-tx', { method: 'POST', body: JSON.stringify(body) });
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

export interface PositionValueResult {
  mint: string;
  amountAtomic: string;
  ok: boolean;
  outLamports?: string;
  priceImpactPct?: string;
  error?: string;
  stale?: boolean;
  quotedAt?: number;
}

export function fetchPositionValues(items: { mint: string; amountAtomic: string }[]): Promise<{
  ok: boolean;
  results: PositionValueResult[];
  at: number;
}> {
  return jsonFetch('/api/sol/position-values', { method: 'POST', body: JSON.stringify({ items }) });
}

export interface DiscoveredToken {
  mint: string;
  symbol: string;
  name: string;
  dex?: string;
  url?: string;
  priceUsd: number | null;
  liquidityUsd: number;
  volume24hUsd: number;
  change1hPct: number | null;
  change24hPct: number | null;
  marketCapUsd: number | null;
  buys1h: number | null;
  sells1h: number | null;
  ranking?: OpportunityRanking;
  ageMinutes: number | null;
  safety: { ok: boolean; blockers: string[]; warnings: string[]; score: number | null };
}

export function fetchDiscover(source: 'trending' | 'new'): Promise<{
  ok: boolean;
  source: string;
  minLiquidityUsd: number;
  tokens: DiscoveredToken[];
  at: string;
}> {
  return jsonFetch(`/api/sol/discover?source=${source}`);
}

export function fetchPricesInSol(mints: string[]): Promise<{ ok: boolean; prices: Record<string, number>; solUsd: number; at: number }> {
  return jsonFetch(`/api/sol/prices?mints=${mints.map(encodeURIComponent).join(',')}`);
}

export interface PaperPosition {
  id: string; mint: string; symbol: string; state: 'open' | 'closed'; openedAt: number;
  costLamports: string; quantityAtomic: string; realisedPnlLamports?: string; proceedsLamports?: string;
  partialExits?: { at: number; percent: number; quantityAtomic: string; proceedsLamports: string; realisedPnlLamports: string }[];
  closedAt?: number; exitReason?: string; exitPending: string | null; lastError: string | null;
  mark: { at: number; netLamports: string; pnlPct: number } | null;
}
export interface PaperPortfolioResponse {
  account: { initial: string; cash: string };
  model: { version: string; latencyMs: number; baseFeeLamports: string; priorityFee: 'jupiter-auto'; entryRentLamports: string; closeAccountFeeLamports?: string; stopLossPct: number; takeProfitPct: number; maxHoldMs: number };
  positions: PaperPosition[];
  stats: { open: number; closed: number; wins: number; realisedPnlLamports: string; equityLamports: string | null; netPnlLamports: string | null };
  workerError: string | null; monitoringEnabled: boolean; at: number;
}
export interface ScanHistoryResponse {
  totals: { observations: number; eligible: number | null; blocked: number | null };
  outcomeCounts: { status: string; count: number }[];
  rows: { id: string; scanId: string; at: number; source: string; mint: string; symbol: string; decision: string;
    safety: { blockers: string[] }; priceUsd: number | null;
    outcomes: { horizon: number; status: string; returnPct: number | null; error: string | null }[] }[];
}
export const fetchPaperPortfolio = () => jsonFetch<PaperPortfolioResponse>('/api/paper/portfolio');
export const refreshPaperPortfolio = () => jsonFetch<PaperPortfolioResponse>('/api/paper/refresh', { method: 'POST' });
export const fetchScanHistory = () => jsonFetch<ScanHistoryResponse>('/api/research/scans?limit=30');
export const openPaperPosition = (body: { id: string; mint: string; symbol: string; amount: number; slippageBps: number }) =>
  jsonFetch<{ position: PaperPosition }>('/api/paper/open', { method: 'POST', body: JSON.stringify(body) });
/** Sells `percent` of a paper position; 100 closes it. */
export const closePaperPosition = (id: string, percent = 100) =>
  jsonFetch<{ position: PaperPosition }>('/api/paper/close', { method: 'POST', body: JSON.stringify({ id, percent }) });

export interface OpportunityRanking {
  version: string; score: number | null; action: 'candidate' | 'watch' | 'blocked'; reasons: string[];
}
export interface ResearchAutomationResponse {
  settings: { scanning: boolean; autoPaper: boolean };
  serviceEnabled: boolean; schedulerError: string | null; monitorError?: string | null; intervalMs: number; at: number;
  policy: { amountSol: number; maxPositions: number; cooldownMs: number };
  jobs: { source: string; next_at: number; lease_until: number; failures: number; last_at: number | null; last_error: string | null }[];
  accounts: { id: string; currentVersion?: boolean; startedAt: number; portfolio: PaperPortfolioResponse;
    decisionCounts: { status: string; count: number }[];
    metrics: { closed: number; wins: number; winRatePct: number | null; netExpectancySol: number | null; profitFactor: number | null;
      noLosingTrades: boolean; maxObservedDrawdownPct: number | null; missingEquitySamples: number; evaluation: string };
    verdict: { status: 'too_few' | 'losing' | 'positive'; beatsBaseline: boolean | null; text: string } }[];
  decisions: { id: string; account_id: string; at: number; mint: string | null; status: string;
    data: { source: string; selectionReason?: string; reason?: string | null; error?: string | null; ranking?: OpportunityRanking | null } }[];
}
export const fetchResearchAutomation = () => jsonFetch<ResearchAutomationResponse>('/api/research/automation');
export const updateResearchAutomation = (settings: Partial<ResearchAutomationResponse['settings']>) =>
  jsonFetch('/api/research/automation', { method: 'POST', body: JSON.stringify(settings) });

export interface LiveTradeRow {
  tradeId: string; signature: string; wallet: string; mint: string; side: 'buy' | 'close' | 'reclaim';
  status: 'confirmed' | 'failed'; slot: number; blockTime: number | null;
  solDeltaLamports: string; tokenDeltaAtomic: string; feeLamports: string; recordedAt: number;
}
export interface LiveTradePosition {
  mint: string; wallet: string; heldAtomic: string; costLamports: string; boughtLamports: string; soldLamports: string;
  rentBackLamports: string; feesLamports: string; realisedPnlLamports: string; trades: number; failed: number;
}
export interface LiveTradeRecordResponse {
  trades: LiveTradeRow[]; positions: LiveTradePosition[];
  totals: { realisedPnlLamports: string; feesLamports: string; openCostLamports: string };
  sync: { stored: number; waiting: number; error: string | null };
  dailyLoss: { dayStart: number; resetsAt: number; realisedTodayLamports: string; lossTodayLamports: string;
    limitLamports: string; blocked: boolean };
}
export const fetchLiveTradeRecord = () => jsonFetch<LiveTradeRecordResponse>('/api/live/trades');
