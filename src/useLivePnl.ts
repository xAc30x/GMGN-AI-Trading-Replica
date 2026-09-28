import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { Position } from './types';
import { fetchPositionValues, fetchPricesInSol } from './api';
import { hasLocalToken } from './localToken';
import { makeConnection } from './solana/constants';
import { readTokenBalance, computePnl } from './pnl';

export interface LivePnl {
  valueSol?: number;
  pnlPct?: number;
  exitValueSol?: number;
  priceImpactPct?: number;
  exitStale?: boolean;
  midValueSol?: number;
  tokenAmount?: number;
  noBalance?: boolean;
  zeroStreak?: number;
  error?: string;
  updatedAt: number;
}
interface Balance { atomic: string; tokenAmount: number; zeroStreak: number; at: number; error?: string }
interface Exit { atomic: string; outLamports: string; priceImpactPct: number; at: number; stale: boolean }
export const BALANCE_REFRESH_MS = 15_000;
export const QUOTE_REFRESH_MS = 1_000;

/** Display-only wallet valuations. Never changes position history or server limit accounting. */
export function useLivePnl(positions: Position[], owner: PublicKey | null, enabled: boolean): { pnl: Record<string, LivePnl>; refreshing: boolean } {
  const address = owner?.toBase58() ?? '';
  const key = JSON.stringify(positions.filter(p => !p.demo && p.chain === 'SOL' && p.address && p.walletAddress === address)
    .map(p => ({ id: p.id, mint: p.address!, cost: p.sizeSol })));
  const scope = `${enabled}:${address}:${key}`;
  const [state, setState] = useState<{ scope: string; pnl: Record<string, LivePnl>; refreshing: boolean }>({ scope: '', pnl: {}, refreshing: false });

  useEffect(() => {
    if (!enabled || !address) return;
    const held = JSON.parse(key) as { id: string; mint: string; cost: number }[];
    if (!held.length) return;
    const connection = makeConnection();
    const balances: Record<string, Balance> = {};
    const exits: Record<string, Exit> = {};
    let mids: { prices: Record<string, number>; at: number } = { prices: {}, at: 0 };
    let cancelled = false;
    let balanceBusy = false;
    let quoteBusy = false;
    let batchStart = 0;
    const publish = () => {
      if (cancelled) return;
      const pnl: Record<string, LivePnl> = {};
      const now = Date.now();
      for (const p of held) {
        const b = balances[p.id];
        if (!b) continue;
        const row: LivePnl = { updatedAt: b.at, error: b.error };
        pnl[p.id] = row;
        // An error must break the zero-balance streak and must not masquerade as fresh valuation.
        if (b.error || now - b.at > BALANCE_REFRESH_MS * 2) {
          row.error ||= 'Wallet balance is stale';
          continue;
        }
        row.tokenAmount = b.tokenAmount;
        row.zeroStreak = b.zeroStreak;
        if (b.atomic === '0') { row.noBalance = true; continue; }
        const x = exits[p.id];
        if (x && x.atomic === b.atomic && now - x.at <= 60_000) {
          row.exitValueSol = computePnl(p.cost, x.outLamports).valueSol;
          row.priceImpactPct = x.priceImpactPct;
          row.exitStale = x.stale || now - x.at > 2_000;
          row.updatedAt = Math.min(b.at, x.at);
        }
        const px = mids.prices[p.mint];
        if (Number.isFinite(px) && px > 0 && now - mids.at <= 10_000) {
          row.midValueSol = b.tokenAmount * px;
          if (row.exitValueSol == null) row.updatedAt = Math.min(b.at, mids.at);
        }
        row.valueSol = row.exitValueSol ?? row.midValueSol;
        if (row.valueSol != null) row.pnlPct = ((row.valueSol - p.cost) / p.cost) * 100;
        else row.error = 'Fresh valuation unavailable';
      }
      setState({ scope, pnl, refreshing: balanceBusy || quoteBusy });
    };
    const quoteTick = async () => {
      if (quoteBusy || document.hidden || !hasLocalToken()) return;
      quoteBusy = true;
      try {
        const eligible = held.filter(p => balances[p.id]?.atomic !== '0' && balances[p.id] && !balances[p.id].error);
        // API accepts eight holdings per batch; rotate so larger portfolios are also refreshed.
        const batch = eligible.length ? [...eligible.slice(batchStart), ...eligible.slice(0, batchStart)].slice(0, 8) : [];
        batchStart = eligible.length ? (batchStart + 8) % eligible.length : 0;
        if (!batch.length) return;
        const items = batch.map(p => ({ mint: p.mint, amountAtomic: balances[p.id].atomic }));
        const [quotes, prices] = await Promise.all([
          fetchPositionValues(items).catch(() => null),
          fetchPricesInSol(items.map(p => p.mint)).catch(() => null),
        ]);
        if (cancelled) return;
        for (let i = 0; i < batch.length; i++) {
          const p = batch[i];
          const item = items[i];
          const q = quotes?.results.find(r => r.mint === item.mint && r.amountAtomic === item.amountAtomic);
          if (q?.ok && q.outLamports && /^\d+$/.test(q.outLamports) && BigInt(q.outLamports) > 0n &&
              Number.isFinite(q.quotedAt) && q.quotedAt! <= Date.now() && Number.isFinite(Number(q.priceImpactPct))) {
            exits[p.id] = { atomic: item.amountAtomic, outLamports: q.outLamports,
              priceImpactPct: Math.abs(Number(q.priceImpactPct)) * 100, at: q.quotedAt!, stale: Boolean(q.stale) };
          } else if (exits[p.id]) exits[p.id].stale = true;
        }
        if (prices) mids = { prices: prices.prices, at: prices.at };
      } finally { quoteBusy = false; publish(); }
    };
    const balanceTick = async () => {
      if (balanceBusy || document.hidden || !hasLocalToken()) return;
      balanceBusy = true;
      try {
        await Promise.all(held.map(async p => {
          try {
            const response = await connection.getParsedTokenAccountsByOwner(new PublicKey(address), { mint: new PublicKey(p.mint) });
            const { atomic, tokenAmount } = readTokenBalance(response.value, address, p.mint);
            const prior = balances[p.id];
            const zeroStreak = atomic === '0' ? (prior?.zeroStreak ?? 0) + 1 : 0;
            if (prior?.atomic !== atomic) delete exits[p.id];
            balances[p.id] = { atomic, tokenAmount, zeroStreak, at: Date.now() };
          } catch (e) {
            balances[p.id] = { atomic: '', tokenAmount: 0, zeroStreak: 0, at: Date.now(), error: e instanceof Error ? e.message : String(e) };
            delete exits[p.id];
          }
        }));
      } finally { balanceBusy = false; publish(); }
      if (!cancelled) void quoteTick();
    };
    void balanceTick();
    const balanceTimer = window.setInterval(() => void balanceTick(), BALANCE_REFRESH_MS);
    const quoteTimer = window.setInterval(() => void quoteTick(), QUOTE_REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(balanceTimer); window.clearInterval(quoteTimer); };
  }, [enabled, address, key, scope]);

  return state.scope === scope ? state : { pnl: {}, refreshing: false };
}
