import { withResearch, transaction } from './researchStore.js';
import { SOL_MINT, getQuote, assertQuoteMatches, solToLamports, clampSlippageBps, jupiterPriorityFee } from './jupiterSol.js';
import { assessMint } from './mintSafety.js';

// v2 charges each side the 5000-lamport signature fee plus the priority fee Jupiter would set for
// that live swap. v1 positions (fixed feeLamports per side) keep their original fee when they exit.
export const PAPER_MODEL = Object.freeze({
  version: 'quote-min-output-v2', latencyMs: 1000, baseFeeLamports: '5000', priorityFee: 'jupiter-auto',
  entryRentLamports: '2039280', stopLossPct: -20, takeProfitPct: 30, maxHoldMs: 3600000,
});
const usesFixedFee = model => model.feeLamports !== undefined;
/** Network fee for one side of a trade: the fixed v1 fee, or the signature fee plus a priority fee. */
const sideFee = (model, priorityFeeLamports) => usesFixedFee(model)
  ? BigInt(model.feeLamports) : BigInt(model.baseFeeLamports) + BigInt(priorityFeeLamports);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const event = (db, at, id, kind, data, accountId) => db.prepare('INSERT INTO paper_events (at, position_id, kind, data, account_id) VALUES (?, ?, ?, ?, ?)')
  .run(at, id, kind, JSON.stringify(data), accountId);
const readPosition = (db, id, accountId = 'manual') => {
  const row = db.prepare('SELECT data FROM paper_positions WHERE id=? AND account_id=?').get(id, accountId);
  return row ? JSON.parse(row.data) : null;
};
const save = (db, p) => db.prepare('UPDATE paper_positions SET state=?, data=? WHERE id=?').run(p.state, JSON.stringify(p), p.id);


const account = (db, accountId) => accountId === 'manual'
  ? db.prepare('SELECT initial, cash FROM paper_account WHERE id=1').get()
  : db.prepare('SELECT initial, cash FROM experiment_accounts WHERE id=?').get(accountId);
const setCash = (db, accountId, cash) => accountId === 'manual'
  ? db.prepare('UPDATE paper_account SET cash=? WHERE id=1').run(String(cash))
  : db.prepare('UPDATE experiment_accounts SET cash=? WHERE id=?').run(String(cash), accountId);

export function paperPortfolio(now = Date.now(), accountId = 'manual') {
  return withResearch(db => {
    const balance = account(db, accountId);
    if (!balance) fail('Paper account not found', 404);
    const positions = db.prepare("SELECT data FROM paper_positions WHERE account_id=? ORDER BY state='open' DESC, created_at DESC LIMIT 100").all(accountId).map(r => JSON.parse(r.data));
    // Accounting aggregates include all trades, even when the display is limited.
    const all = db.prepare('SELECT data FROM paper_positions WHERE account_id=?').all(accountId).map(r => JSON.parse(r.data));
    const open = all.filter(p => p.state === 'open');
    const closed = all.filter(p => p.state === 'closed');
    // Open positions carry realised P&L from partial sells; closed ones carry their full total.
    const realised = all.reduce((sum, p) => sum + BigInt(p.realisedPnlLamports ?? '0'), 0n);
    const valued = open.every(p => p.mark && !p.lastError && now - p.mark.at <= 45000);
    const equity = valued ? BigInt(balance.cash) + open.reduce((sum, p) => sum + BigInt(p.mark.netLamports), 0n) : null;
    return { account: balance, accountId, model: PAPER_MODEL, positions, at: now,
      stats: { open: open.length, closed: closed.length, wins: closed.filter(p => BigInt(p.realisedPnlLamports) > 0n).length,
        realisedPnlLamports: String(realised), equityLamports: equity === null ? null : String(equity),
        netPnlLamports: equity === null ? null : String(equity - BigInt(balance.initial)) },
      events: db.prepare('SELECT at, position_id AS positionId, kind, data FROM paper_events WHERE account_id=? ORDER BY id DESC LIMIT 20').all(accountId)
        .map(r => ({ ...r, data: JSON.parse(r.data) })),
    };
  });
}

export function createPaperEngine({ quote = getQuote, priorityFee = jupiterPriorityFee, safety = assessMint, now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxAmount = () => 0.05,
  model = PAPER_MODEL, accountId = 'manual', maxPositions = 5, cooldownMs = 0, canOpen = () => true } = {}) {
  const recordEvent = (db, at, id, kind, data) => event(db, at, id, kind, data, accountId);
  let refreshing = null;
  const closing = new Map();
  const partials = new Set();
  async function freshQuote(inputMint, outputMint, amountAtomic, slippageBps) {
    const intent = { inputMint, outputMint, amountAtomic, slippageBps };
    const q = await quote(intent);
    assertQuoteMatches(q, intent);
    return q;
  }
  // Fee for selling this quote now; v1 positions never ask Jupiter.
  const exitFee = async (p, q) => sideFee(p.model, usesFixedFee(p.model) ? '0' : await priorityFee(q));
  // Marks run every few seconds, so they estimate the exit fee from the entry's priority fee.
  const estimatedExitFee = p => sideFee(p.model, p.entryPriorityFeeLamports ?? '0');

  async function open({ id, mint, symbol, amount, slippageBps, observationId, selection }) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(id)) fail('A stable paper request id is required');
    const lamports = solToLamports(amount);
    if (lamports <= 0n || lamports > solToLamports(maxAmount())) fail('Paper amount exceeds the per-trade cap');
    const slip = clampSlippageBps(slippageBps);
    const fingerprint = JSON.stringify([mint, String(lamports), slip]);
    const existing = withResearch(db => readPosition(db, id, accountId));
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('Paper request id reused with different inputs', 409);
      return existing;
    }
    const requestedAt = now();
    if (!withResearch(db => canOpen(db, selection))) fail('Automatic paper entries paused or signal expired', 409);
    try {
      const assessment = await safety(mint);
      if (!assessment.ok) fail(`Paper entry blocked: ${assessment.blockers?.[0] || 'safety check failed'}`);
      await sleep(model.latencyMs);
      const q = await freshQuote(SOL_MINT, mint, String(lamports), slip);
      const entryPriorityFee = usesFixedFee(model) ? '0' : await priorityFee(q);
      const cost = lamports + sideFee(model, entryPriorityFee) + BigInt(model.entryRentLamports);
      return withResearch(db => transaction(db, () => {
        const duplicate = readPosition(db, id, accountId);
        if (duplicate) {
          if (duplicate.fingerprint !== fingerprint) fail('Paper request id reused with different inputs', 409);
          return duplicate;
        }
        if (!canOpen(db, selection)) fail('Automatic paper entries paused or signal expired', 409);
        const cash = BigInt(account(db, accountId).cash);
        if (cash < cost) fail('Insufficient virtual SOL');
        if (db.prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE account_id=? AND state='open'").get(accountId).n >= maxPositions) fail(`Paper portfolio limit: ${maxPositions} open positions`);
        if (db.prepare("SELECT id FROM paper_positions WHERE account_id=? AND mint=? AND state='open'").get(accountId, mint)) fail('A paper position for this mint is already open', 409);
        if (cooldownMs && db.prepare('SELECT id FROM paper_positions WHERE account_id=? AND mint=? AND created_at>?').get(accountId, mint, now() - cooldownMs)) fail('Paper mint cooldown active', 409);
        const observation = db.prepare('SELECT id FROM observations WHERE mint=? AND at<=? ORDER BY at DESC LIMIT 1').get(mint, requestedAt);
        const p = { id, accountId, selection: selection ?? null, fingerprint, mint, symbol: String(symbol || mint.slice(0, 6)).slice(0, 16), state: 'open',
          requestedAt, openedAt: now(), amountLamports: String(lamports), costLamports: String(cost),
          quantityAtomic: q.otherAmountThreshold, slippageBps: slip, model: { ...model }, entryPriorityFeeLamports: entryPriorityFee,
          observationId: observationId ?? observation?.id ?? null, entryQuote: q, entrySafety: assessment,
          mark: null, lastError: null, exitPending: null };
        db.prepare('INSERT INTO paper_positions (id, mint, state, created_at, data, account_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, mint, 'open', p.openedAt, JSON.stringify(p), accountId);
        setCash(db, accountId, cash - cost);
        recordEvent(db, now(), id, 'entry', { costLamports: p.costLamports, quantityAtomic: p.quantityAtomic });
        return p;
      }));
    } catch (e) {
      withResearch(db => recordEvent(db, now(), id, 'entry_failed', { mint, error: e.message }));
      throw e;
    }
  }

  function close(id, reason = 'manual') {
    if (closing.has(id)) return closing.get(id);
    const work = (async () => {
      const p = withResearch(db => transaction(db, () => {
        const value = readPosition(db, id, accountId);
        if (!value) fail('Paper position not found', 404);
        if (value.state !== 'closed') {
          value.exitPending ||= reason;
          save(db, value);
        }
        return value;
      }));
      if (p.state === 'closed') return p;
      try {
        await sleep(p.model.latencyMs);
        const q = await freshQuote(p.mint, SOL_MINT, p.quantityAtomic, p.slippageBps);
        const fee = await exitFee(p, q);
        const net = BigInt(q.otherAmountThreshold) - fee;
        return withResearch(db => transaction(db, () => {
          const current = readPosition(db, id, accountId);
          if (current.state === 'closed') return current;
          // Partial sells refuse once exitPending is set, so this is a second guard: never credit a stale size.
          if (current.quantityAtomic !== p.quantityAtomic) fail('Position size changed during exit; retrying', 409);
          const cash = BigInt(account(db, accountId).cash);
          const priorProceeds = BigInt(current.proceedsLamports ?? '0');
          const priorRealised = BigInt(current.realisedPnlLamports ?? '0');
          Object.assign(current, { state: 'closed', closedAt: now(), exitReason: current.exitPending,
            exitQuote: q, exitFeeLamports: String(fee), proceedsLamports: String(priorProceeds + net),
            realisedPnlLamports: String(priorRealised + net - BigInt(current.costLamports)),
            exitPending: null, lastError: null });
          save(db, current);
          setCash(db, accountId, cash + net);
          recordEvent(db, now(), id, 'exit', { reason: current.exitReason, proceedsLamports: String(net), realisedPnlLamports: current.realisedPnlLamports });
          return current;
        }));
      } catch (e) {
        withResearch(db => transaction(db, () => {
          const current = readPosition(db, id, accountId);
          if (current.state === 'closed') return;
          current.lastError = e.message; save(db, current);
          recordEvent(db, now(), id, 'exit_failed', { error: e.message });
        }));
        throw e;
      }
    })().finally(() => closing.delete(id));
    closing.set(id, work);
    return work;
  }

  /**
   * Sell a whole-number percent (1-100) of an open position. 100 is exactly close().
   * A partial sell keeps the position open with a proportionally smaller quantity and cost,
   * so stop/target checks apply to what is left. It is never retried automatically.
   */
  async function sell(id, percent = 100) {
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) fail('Sell percent must be a whole number from 1 to 100');
    if (percent === 100) return close(id, 'manual');
    if (closing.has(id) || partials.has(id)) fail('A sale for this position is already in progress', 409);
    partials.add(id);
    try {
      const p = withResearch(db => readPosition(db, id, accountId));
      if (!p) fail('Paper position not found', 404);
      if (p.state !== 'open') fail('Paper position is already closed', 409);
      if (p.exitPending) fail('A full exit is already pending for this position', 409);
      const sellAtomic = BigInt(p.quantityAtomic) * BigInt(percent) / 100n;
      if (sellAtomic <= 0n) fail('Sell amount rounds to zero');
      await sleep(p.model.latencyMs);
      const q = await freshQuote(p.mint, SOL_MINT, String(sellAtomic), p.slippageBps);
      const fee = await exitFee(p, q);
      const net = BigInt(q.otherAmountThreshold) - fee;
      if (net <= 0n) fail('Sale is too small to cover the modeled network fee');
      return withResearch(db => transaction(db, () => {
        const current = readPosition(db, id, accountId);
        if (current.state !== 'open' || current.exitPending || current.quantityAtomic !== p.quantityAtomic) {
          fail('Position changed while the sale was being quoted; try again', 409);
        }
        const quantity = BigInt(current.quantityAtomic);
        const cost = BigInt(current.costLamports);
        const costSold = cost * sellAtomic / quantity;
        const pnl = net - costSold;
        const cash = BigInt(account(db, accountId).cash);
        Object.assign(current, {
          quantityAtomic: String(quantity - sellAtomic), costLamports: String(cost - costSold),
          proceedsLamports: String(BigInt(current.proceedsLamports ?? '0') + net),
          realisedPnlLamports: String(BigInt(current.realisedPnlLamports ?? '0') + pnl),
          partialExits: [...(current.partialExits ?? []), { at: now(), percent, quantityAtomic: String(sellAtomic),
            proceedsLamports: String(net), feeLamports: String(fee), realisedPnlLamports: String(pnl), quote: q }],
          // The previous mark valued the old size; equity stays unknown until the next refresh.
          mark: null, lastError: null,
        });
        save(db, current);
        setCash(db, accountId, cash + net);
        recordEvent(db, now(), id, 'partial_exit', { percent, quantityAtomic: String(sellAtomic),
          proceedsLamports: String(net), realisedPnlLamports: String(pnl) });
        return current;
      }));
    } finally {
      partials.delete(id);
    }
  }

  async function tick() {
    const positions = withResearch(db => db.prepare("SELECT data FROM paper_positions WHERE state='open' AND account_id=?").all(accountId).map(r => JSON.parse(r.data)));
    for (const p of positions) {
      try {
        if (p.exitPending) { await close(p.id, p.exitPending); continue; }
        const q = await freshQuote(p.mint, SOL_MINT, p.quantityAtomic, p.slippageBps);
        const net = BigInt(q.otherAmountThreshold) - estimatedExitFee(p);
        const pnlPct = Number(net - BigInt(p.costLamports)) / Number(p.costLamports) * 100;
        withResearch(db => transaction(db, () => {
          const current = readPosition(db, p.id, accountId);
          if (current.state === 'closed') return;
          current.mark = { at: now(), netLamports: String(net), pnlPct };
          current.lastError = null; save(db, current);
        }));
        const reason = pnlPct <= p.model.stopLossPct ? 'stop_loss' : pnlPct >= p.model.takeProfitPct ? 'take_profit'
          : now() - p.openedAt >= p.model.maxHoldMs ? 'time_exit' : null;
        if (reason) await close(p.id, reason);
      } catch (e) {
        withResearch(db => transaction(db, () => {
          const current = readPosition(db, p.id, accountId);
          if (current.state !== 'open') return;
          current.lastError = e.message; save(db, current);
        }));
      }
    }
    return paperPortfolio(now(), accountId);
  }
  function refresh() {
    if (!refreshing) refreshing = tick().finally(() => { refreshing = null; });
    return refreshing;
  }
  return { open, close, sell, refresh };
}
