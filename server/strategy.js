// Frozen research hypotheses, not calibrated win probabilities. Bump versions when rules change.
export const RANKED_VERSION = 'momentum-quality-v1';
export const BASELINE_VERSION = 'safety-feed-v1';
export const EXPERIMENT_VERSIONS = [RANKED_VERSION, BASELINE_VERSION];
export const EXPERIMENT_POLICY = Object.freeze({ amountSol: 0.01, slippageBps: 100, maxPositions: 3,
  cooldownMs: 24 * 3600000, maxSignalAgeMs: 120000, maxEntriesPerScan: 1 });
export const RANKING_RULES = Object.freeze({ minLiquidityUsd: 25000, minAgeMinutes: 30,
  maxAgeMinutes: 10080, minTransactions1h: 30, minBuyShare: 0.55,
  minChange1hPct: 0, maxChange1hPct: 30, maxChange5mPct: 15, minScore: 60 });
const valid = value => typeof value === 'number' && Number.isFinite(value);

export function scoreOpportunity(token, at = Date.now()) {
  const result = { version: RANKED_VERSION, evaluatedAt: at, score: null, action: 'watch', reasons: [], features: {} };
  if (!token.safety?.ok) return { ...result, action: 'blocked', reasons: token.safety?.blockers || ['Safety unavailable'] };
  const keys = ['priceUsd', 'liquidityUsd', 'ageMinutes', 'buys1h', 'sells1h', 'volume1hUsd', 'volume5mUsd', 'change1hPct', 'change5mPct'];
  const missing = keys.filter(key => !valid(token[key]));
  if (missing.length) return { ...result, reasons: [`Missing data: ${missing.join(', ')}`] };
  const transactions = token.buys1h + token.sells1h;
  const buyShare = transactions > 0 ? token.buys1h / transactions : 0;
  const acceleration = token.volume1hUsd > 0 ? token.volume5mUsd * 12 / token.volume1hUsd : 0;
  result.features = { transactions1h: transactions, buyShare, volumeAcceleration: acceleration };
  if (token.priceUsd <= 0 || token.liquidityUsd < RANKING_RULES.minLiquidityUsd) result.reasons.push('Liquidity below $25k or price unavailable');
  if (token.ageMinutes < 30 || token.ageMinutes > 10080) result.reasons.push('Pair age outside 30m–7d');
  if (transactions < 30 || buyShare < 0.55) result.reasons.push('Insufficient buy pressure / activity');
  if (token.change1hPct <= 0 || token.change1hPct > 30 || token.change5mPct < 0 || token.change5mPct > 15) result.reasons.push('Momentum weak or price already extended');
  if (token.volume1hUsd <= 0 || token.volume5mUsd <= 0 || token.buys1h < 0 || token.sells1h < 0) result.reasons.push('Invalid or inactive market');
  const clamp = n => Math.max(0, Math.min(1, n));
  result.score = Math.round(25 * clamp(token.liquidityUsd / 100000) + 25 * clamp((buyShare - 0.5) / 0.2)
    + 25 * clamp(acceleration / 2) + 25 * clamp(token.change1hPct / 10));
  if (result.score < 60) result.reasons.push('Score below 60');
  if (!result.reasons.length) {
    result.action = 'candidate';
    result.reasons = ['Positive momentum, buy pressure and sufficient liquidity'];
  }
  return result;
}

export function rankCandidates(tokens, at = Date.now()) {
  return tokens.map((token, feedOrder) => ({ ...token, feedOrder, ranking: scoreOpportunity(token, at) }))
    .sort((a, b) => (b.ranking.action === 'candidate') - (a.ranking.action === 'candidate')
      || (b.ranking.score ?? -1) - (a.ranking.score ?? -1) || a.feedOrder - b.feedOrder);
}

// Fewer closed trades than this is too small a sample to say anything about a strategy.
export const MIN_JUDGED_TRADES = 30;

export function tradeMetrics(positions, equityPoints, initial = 1000000000n) {
  const closed = positions.filter(p => p.state === 'closed');
  const values = closed.map(p => Number(p.realisedPnlLamports) / 1e9);
  const gains = values.reduce((sum, n) => sum + Math.max(n, 0), 0);
  const losses = -values.reduce((sum, n) => sum + Math.min(n, 0), 0);
  let peak = Number(initial); let drawdown = 0;
  for (const point of equityPoints) {
    if (point.equity === null) continue;
    const value = Number(point.equity);
    peak = Math.max(peak, value);
    if (peak > 0) drawdown = Math.max(drawdown, (peak - value) / peak * 100);
  }
  const wins = values.filter(n => n > 0).length;
  return { closed: closed.length, wins,
    winRatePct: values.length ? wins / values.length * 100 : null,
    netExpectancySol: values.length ? (gains - losses) / values.length : null,
    profitFactor: losses > 0 ? gains / losses : null,
    noLosingTrades: values.length > 0 && losses === 0,
    maxObservedDrawdownPct: equityPoints.some(p => p.equity !== null) ? drawdown : null,
    equitySamples: equityPoints.filter(p => p.equity !== null).length,
    missingEquitySamples: equityPoints.filter(p => p.equity === null).length,
    evaluation: closed.length < MIN_JUDGED_TRADES ? 'Insufficient sample' : 'Prospective paper results; no statistical edge established' };
}

/**
 * Plain-language summary of a strategy's paper results after costs.
 * The baseline comparison is only made when both strategies have enough closed trades.
 */
export function strategyVerdict(metrics, baseline = null) {
  if (metrics.closed < MIN_JUDGED_TRADES || metrics.netExpectancySol === null) {
    return { status: 'too_few', beatsBaseline: null,
      text: `Too few trades to judge: ${metrics.closed} of ${MIN_JUDGED_TRADES} closed.` };
  }
  const comparable = baseline && baseline.closed >= MIN_JUDGED_TRADES && baseline.netExpectancySol !== null;
  const beatsBaseline = comparable ? metrics.netExpectancySol > baseline.netExpectancySol : null;
  const versus = beatsBaseline === null ? '' : beatsBaseline
    ? ' It did better than the plain baseline.' : ' It did no better than the plain baseline.';
  if (metrics.netExpectancySol <= 0) {
    return { status: 'losing', beatsBaseline,
      text: `Losing after costs over ${metrics.closed} trades.${versus}` };
  }
  return { status: 'positive', beatsBaseline,
    text: `Made money on paper after costs over ${metrics.closed} trades. This is not proof it will work with real money.${versus}` };
}
