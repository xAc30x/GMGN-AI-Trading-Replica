export interface WatchMint {
  mint: string;
  symbol?: string;
  addedAt: number;
}

const KEY = 'gmgn.watchlist.v1';

const DEFAULT_WATCH: WatchMint[] = [
  {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK',
    addedAt: 0,
  },
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    addedAt: 0,
  },
];

export function loadWatchlist(): WatchMint[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      localStorage.setItem(KEY, JSON.stringify(DEFAULT_WATCH));
      return [...DEFAULT_WATCH];
    }
    const parsed = JSON.parse(raw) as WatchMint[];
    if (!Array.isArray(parsed)) return [...DEFAULT_WATCH];
    return parsed.filter((w) => w && typeof w.mint === 'string' && w.mint.length >= 32);
  } catch {
    return [...DEFAULT_WATCH];
  }
}

export function saveWatchlist(list: WatchMint[]): void {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 8)));
}

export function addWatchMint(mint: string, symbol?: string): WatchMint[] {
  const m = mint.trim();
  const list = loadWatchlist().filter((w) => w.mint !== m);
  list.unshift({ mint: m, symbol: symbol?.trim() || undefined, addedAt: Date.now() });
  const next = list.slice(0, 8);
  saveWatchlist(next);
  return next;
}

export function removeWatchMint(mint: string): WatchMint[] {
  const next = loadWatchlist().filter((w) => w.mint !== mint);
  saveWatchlist(next);
  return next;
}

export function shortMint(mint: string): string {
  if (mint.length < 10) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}
