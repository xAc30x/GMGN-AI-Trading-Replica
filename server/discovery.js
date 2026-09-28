// Token discovery from DexScreener's free public API (no key). Read-only market data.
const DS = 'https://api.dexscreener.com';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
export const DISCOVERY_SOURCES = { trending: '/token-boosts/top/v1', new: '/token-profiles/latest/v1' };

const responses = new Map();
const pending = new Map();
async function dsJson(pathname) {
  const ttl = pathname.startsWith('/tokens/') ? 1_000 : 60_000;
  const hit = responses.get(pathname);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  if (pending.has(pathname)) return pending.get(pathname);
  const request = fetchDsJson(pathname).then(value => {
    responses.set(pathname, { value, at: Date.now() });
    if (responses.size > 100) responses.delete(responses.keys().next().value);
    return value;
  }).finally(() => pending.delete(pathname));
  pending.set(pathname, request);
  return request;
}
async function fetchDsJson(pathname) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(DS + pathname, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Invalid DexScreener response');
    return data;
  } finally {
    clearTimeout(t);
  }
}

/** Unique Solana token addresses from a boosts/profiles list, in feed order. */
export function solanaAddresses(list, limit = 30) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const a = x?.chainId === 'solana' ? String(x.tokenAddress || '') : '';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) || a === SOL_MINT || STABLES.has(a) || out.includes(a)) continue;
    out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}

const finite = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const positive = value => Math.max(0, finite(value) ?? 0);
/** Deepest-liquidity pair per token where the token is the base asset, reduced to the fields the UI shows. */
export function summarizePairs(pairs, addresses, now = Date.now()) {
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const mint = p?.baseToken?.address;
    if (p?.chainId !== 'solana' || !addresses.includes(mint)) continue;
    const liq = positive(p?.liquidity?.usd);
    if (!best.has(mint) || liq > best.get(mint).liquidityUsd) {
      best.set(mint, {
        mint,
        symbol: String(p.baseToken.symbol || '').slice(0, 16),
        name: String(p.baseToken.name || '').slice(0, 40),
        dex: p.dexId,
        pairAddress: p.pairAddress,
        url: `https://dexscreener.com/solana/${encodeURIComponent(mint)}`,
        priceUsd: positive(p.priceUsd) || null,
        liquidityUsd: liq,
        volume24hUsd: positive(p?.volume?.h24),
        change1hPct: finite(p?.priceChange?.h1),
        change24hPct: finite(p?.priceChange?.h24),
        marketCapUsd: positive(p.marketCap ?? p.fdv) || null,
        buys1h: positive(p?.txns?.h1?.buys),
        sells1h: positive(p?.txns?.h1?.sells),
        ageMinutes: positive(p.pairCreatedAt) ? Math.max(0, Math.round((now - Number(p.pairCreatedAt)) / 60000)) : null,
      });
    }
  }
  return addresses.map((a) => best.get(a)).filter(Boolean);
}

export async function discoverTokens(source, { minLiquidityUsd = 0, limit = 15, includeUnavailable = false } = {}) {
  const path = DISCOVERY_SOURCES[source];
  if (!path) throw Object.assign(new Error('source must be trending or new'), { status: 400 });
  const addresses = solanaAddresses(await dsJson(path), 30);
  if (!addresses.length) return [];
  const pairs = await dsJson(`/tokens/v1/solana/${addresses.join(',')}`);
  const summaries = summarizePairs(pairs, addresses);
  const candidates = includeUnavailable ? addresses.map(mint => summaries.find(t => t.mint === mint) || {
    mint, symbol: '', priceUsd: null, liquidityUsd: 0, missingMarketData: true,
  }) : summaries;
  return candidates
    .filter((t) => t.liquidityUsd >= minLiquidityUsd)
    .slice(0, limit);
}

/** Deepest-liquidity USD price per mint (base-token pairs only). */
export function usdPricesFromPairs(pairs, mints) {
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const mint = p?.baseToken?.address;
    const price = positive(p?.priceUsd);
    const liq = positive(p?.liquidity?.usd);
    if (p?.chainId !== 'solana' || !mints.includes(mint) || !(price > 0)) continue;
    if (!best.has(mint) || liq > best.get(mint).liq) best.set(mint, { price, liq });
  }
  return Object.fromEntries([...best].map(([m, v]) => [m, v.price]));
}

let priceCache = { key: '', at: 0, value: null };
/** Token prices in SOL (via USD / SOL-USD), cached ~800ms so a 1s UI tick never hammers DexScreener. */
export async function pricesInSol(mints) {
  const list = [...new Set([SOL_MINT, ...mints])];
  const key = list.slice().sort().join(',');
  if (priceCache.key === key && Date.now() - priceCache.at < 800) return priceCache.value;
  const usd = usdPricesFromPairs(await dsJson(`/tokens/v1/solana/${list.join(',')}`), list);
  const solUsd = usd[SOL_MINT];
  if (!(solUsd > 0)) throw new Error('SOL price unavailable');
  const prices = {};
  for (const m of mints) if (usd[m] > 0) prices[m] = usd[m] / solUsd;
  const value = { prices, solUsd, at: Date.now() };
  priceCache = { key, at: Date.now(), value };
  return value;
}

export async function marketPricesUsd(mints) {
  return usdPricesFromPairs(await dsJson(`/tokens/v1/solana/${mints.join(',')}`), mints);
}

export async function marketSnapshots(mints) {
  if (!mints.length) return [];
  return summarizePairs(await dsJson(`/tokens/v1/solana/${mints.join(',')}`), mints);
}
