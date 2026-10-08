/**
 * Durable record of live trades as they actually happened on chain.
 * For every broadcast the trade ledger knows about, the confirmed transaction is read back and
 * the wallet's real SOL change (swap amount, network fees and account rent together) and token
 * change are stored. Failed transactions are stored too, because their fees were still paid.
 * This module never signs or sends anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sentBroadcasts } from './tradeLedger.js';

const DEFAULT_PATH = fileURLToPath(new URL('./.live-trades.sqlite', import.meta.url));
const MAX_LOOKUPS_PER_SYNC = 10;
// A swap's blockhash expires about 90 seconds after it is built, so a transaction the RPC still
// cannot find this long after it was sent never landed. It is marked so it is not looked up forever.
const NOT_LANDED_AFTER_MS = 10 * 60_000;
const fail = (message, status = 502) => { throw Object.assign(new Error(message), { status }); };

function withLiveTrades(action) {
  const file = process.env.GMGN_LIVE_TRADES_PATH || DEFAULT_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600);
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS live_trades (
        trade_id TEXT PRIMARY KEY, signature TEXT NOT NULL UNIQUE, wallet TEXT NOT NULL, mint TEXT NOT NULL,
        side TEXT NOT NULL, status TEXT NOT NULL, slot INTEGER NOT NULL, block_time INTEGER,
        sol_delta_lamports TEXT NOT NULL, token_delta_atomic TEXT NOT NULL, fee_lamports TEXT NOT NULL,
        recorded_at INTEGER NOT NULL);`);
    return action(db);
  } finally {
    db.close();
  }
}

const tradeMint = broadcast => broadcast.side === 'buy' ? broadcast.intent?.outputMint : broadcast.intent?.inputMint;

const ownerTokenAmount = (balances, wallet, mint) => (balances ?? [])
  .filter(b => b.owner === wallet && b.mint === mint)
  .reduce((sum, b) => sum + BigInt(b.uiTokenAmount?.amount ?? '0'), 0n);

/**
 * What a confirmed transaction did to the wallet. Returns null while the RPC has no record yet.
 * The wallet must be the fee payer (account 0), which every authorized LIVE build requires.
 */
export function readSettlement(tx, { wallet, mint }) {
  if (!tx) return null;
  const meta = tx.meta;
  const keys = tx.transaction?.message?.staticAccountKeys ?? tx.transaction?.message?.accountKeys;
  const payer = keys?.[0]?.toBase58?.() ?? keys?.[0];
  if (!meta || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) fail('Transaction has no balance details');
  if (payer !== wallet) fail('Transaction fee payer is not the trading wallet');
  if (!Number.isSafeInteger(tx.slot)) fail('Transaction has no slot');
  return {
    status: meta.err ? 'failed' : 'confirmed',
    slot: tx.slot,
    blockTime: Number.isSafeInteger(tx.blockTime) ? tx.blockTime * 1000 : null,
    solDeltaLamports: String(BigInt(meta.postBalances[0]) - BigInt(meta.preBalances[0])),
    tokenDeltaAtomic: String(ownerTokenAmount(meta.postTokenBalances, wallet, mint) - ownerTokenAmount(meta.preTokenBalances, wallet, mint)),
    feeLamports: String(BigInt(meta.fee ?? 0)),
  };
}

/**
 * Looks up broadcasts that have no on-chain record stored yet. Ones the RPC cannot find yet are
 * left for the next sync. Returns how many were stored and the first lookup error, if any.
 */
export async function syncLiveTrades({ connection, broadcasts = sentBroadcasts, now = Date.now } = {}) {
  const known = withLiveTrades(db => new Set(db.prepare('SELECT trade_id FROM live_trades').all().map(r => r.trade_id)));
  const missing = broadcasts().filter(b => !known.has(b.tradeId) && tradeMint(b)).slice(0, MAX_LOOKUPS_PER_SYNC);
  let stored = 0; let error = null;
  for (const b of missing) {
    try {
      const tx = await connection.getTransaction(b.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      let settled = readSettlement(tx, { wallet: b.wallet, mint: tradeMint(b) });
      if (!settled && Number.isSafeInteger(b.updatedAt) && now() - b.updatedAt > NOT_LANDED_AFTER_MS) {
        settled = { status: 'not_landed', slot: 0, blockTime: null, solDeltaLamports: '0', tokenDeltaAtomic: '0', feeLamports: '0' };
      }
      if (!settled) continue;
      withLiveTrades(db => db.prepare(`INSERT OR IGNORE INTO live_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        b.tradeId, b.signature, b.wallet, tradeMint(b), b.side, settled.status, settled.slot, settled.blockTime,
        settled.solDeltaLamports, settled.tokenDeltaAtomic, settled.feeLamports, now()));
      stored++;
    } catch (e) {
      error ??= `${b.signature.slice(0, 8)}…: ${e.message}`;
    }
  }
  return { stored, waiting: missing.length - stored, error };
}

/**
 * Per-token totals using average cost. A buy's cost is all the SOL that left the wallet
 * (swap, fees and rent); a sell's proceeds are all the SOL that came back. A failed
 * transaction adds its fee to realised loss without changing the holding.
 */
export function summarizeLiveTrades(trades) {
  const byMint = new Map();
  const realised = [];
  for (const t of [...trades].sort((a, b) => a.slot - b.slot || a.tradeId.localeCompare(b.tradeId))) {
    const m = byMint.get(t.mint) ?? { mint: t.mint, wallet: t.wallet, heldAtomic: 0n, costLamports: 0n,
      boughtLamports: 0n, soldLamports: 0n, feesLamports: 0n, realisedPnlLamports: 0n, trades: 0, failed: 0 };
    byMint.set(t.mint, m);
    const sol = BigInt(t.solDeltaLamports);
    const tokens = BigInt(t.tokenDeltaAtomic);
    m.trades++; m.feesLamports += BigInt(t.feeLamports);
    const at = t.blockTime ?? t.recordedAt;
    if (t.status === 'failed') {
      m.failed++; m.realisedPnlLamports += sol;
      realised.push({ tradeId: t.tradeId, at, lamports: sol });
    } else if (t.side === 'buy') {
      m.boughtLamports += -sol; m.costLamports += -sol; m.heldAtomic += tokens;
    } else {
      const sold = -tokens;
      // Selling more than this record knows of (tokens bought elsewhere) books it at zero cost.
      const costSold = m.heldAtomic > 0n ? m.costLamports * (sold < m.heldAtomic ? sold : m.heldAtomic) / m.heldAtomic : 0n;
      m.soldLamports += sol; m.realisedPnlLamports += sol - costSold;
      realised.push({ tradeId: t.tradeId, at, lamports: sol - costSold });
      m.costLamports -= costSold; m.heldAtomic = m.heldAtomic > sold ? m.heldAtomic - sold : 0n;
    }
  }
  const positions = [...byMint.values()].map(m => Object.fromEntries(Object.entries(m)
    .map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v])));
  const total = key => String(positions.reduce((sum, p) => sum + BigInt(p[key]), 0n));
  return { positions, realised, totals: { realisedPnlLamports: total('realisedPnlLamports'), feesLamports: total('feesLamports'),
    openCostLamports: total('costLamports') } };
}

export function liveTradeRecord({ wallet } = {}) {
  const trades = withLiveTrades(db => db.prepare(`SELECT trade_id AS tradeId, signature, wallet, mint, side, status, slot,
    block_time AS blockTime, sol_delta_lamports AS solDeltaLamports, token_delta_atomic AS tokenDeltaAtomic,
    fee_lamports AS feeLamports, recorded_at AS recordedAt FROM live_trades WHERE status<>'not_landed' ${wallet ? 'AND wallet=?' : ''} ORDER BY slot DESC`)
    .all(...(wallet ? [wallet] : [])));
  const { realised: _perTrade, ...summary } = summarizeLiveTrades(trades);
  return { trades, ...summary };
}

/** Start of the current day in UTC, so the limit resets at the same moment wherever the server runs. */
export const utcDayStart = now => Math.floor(now / 86_400_000) * 86_400_000;

/**
 * Today's realised live result across all wallets: sells against their average cost, plus fees
 * of failed transactions. Losses on tokens still held are not counted until they are sold.
 */
export function dailyLossStatus({ limitLamports, now = Date.now() }) {
  const trades = withLiveTrades(db => db.prepare(`SELECT trade_id AS tradeId, wallet, mint, side, status, slot,
    block_time AS blockTime, sol_delta_lamports AS solDeltaLamports, token_delta_atomic AS tokenDeltaAtomic,
    fee_lamports AS feeLamports, recorded_at AS recordedAt FROM live_trades WHERE status<>'not_landed'`).all());
  const dayStart = utcDayStart(now);
  const today = summarizeLiveTrades(trades).realised.filter(r => r.at >= dayStart)
    .reduce((sum, r) => sum + r.lamports, 0n);
  const loss = today < 0n ? -today : 0n;
  return { dayStart, resetsAt: dayStart + 86_400_000, realisedTodayLamports: String(today),
    lossTodayLamports: String(loss), limitLamports: String(limitLamports), blocked: loss >= BigInt(limitLamports) };
}

/**
 * Refuses a new live buy once today's realised loss reaches the limit. It first records any
 * sent trades it can find, and refuses when it cannot, because an unknown loss is not a small one.
 * Sells never call this.
 */
export async function assertDailyLossAllowsBuy({ connection, limitLamports, now = Date.now, sync = syncLiveTrades }) {
  const synced = await sync({ connection });
  if (synced.error) fail(`Cannot check today's live losses right now (${synced.error}). Try again shortly.`, 503);
  const status = dailyLossStatus({ limitLamports, now: now() });
  if (status.blocked) {
    fail(`Daily loss limit reached: lost ${Number(status.lossTodayLamports) / 1e9} SOL today (limit ${Number(limitLamports) / 1e9} SOL). `
      + 'New live buys are paused until 00:00 UTC. Selling still works.', 403);
  }
  return status;
}
