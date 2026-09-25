/**
 * Full-ish rug / honeypot scan via RugCheck + GoPlus (public endpoints).
 * Merges into mint-safety: danger findings become blockers.
 */
const RUGCHECK_BASE = process.env.RUGCHECK_API_BASE || 'https://api.rugcheck.xyz/v1';
const GOPLUS_BASE = process.env.GOPLUS_API_BASE || 'https://api.gopluslabs.io/api/v1';
/** RugCheck score_normalised above this blocks (higher = riskier). */
export const MAX_RUG_SCORE = Number(process.env.GMGN_MAX_RUG_SCORE || 40);
/** Min USD market liquidity from RugCheck (0 disables). */
export const MIN_LIQUIDITY_USD = Number(process.env.GMGN_MIN_LIQUIDITY_USD || 1000);

const AUTHORITY_ALLOWLIST = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'So11111111111111111111111111111111111111112',
]);

const DANGER_LEVELS = new Set(['danger', 'critical', 'severe', 'error']);

async function fetchJson(url, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 300) };
    }
    if (!res.ok) {
      const err = new Error(data.error || data.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function statusOn(field) {
  if (!field || typeof field !== 'object') return false;
  return String(field.status) === '1' || field.status === 1 || field.status === true;
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   providerErrors: string[],
 *   checks: Array<{id:string,ok:boolean,detail:string,level?:string}>,
 *   blockers: string[],
 *   warnings: string[],
 *   rugcheck?: object,
 *   goplus?: object,
 * }>}
 */
export async function scanRug(mintAddress) {
  const mint = String(mintAddress || '').trim();
  const checks = [];
  const blockers = [];
  const warnings = [];
  const providerErrors = [];
  const allowlisted = AUTHORITY_ALLOWLIST.has(mint);

  let rug = null;
  let go = null;

  const [rugRes, goRes] = await Promise.allSettled([
    fetchJson(`${RUGCHECK_BASE}/tokens/${encodeURIComponent(mint)}/report`),
    fetchJson(
      `${GOPLUS_BASE}/solana/token_security?contract_addresses=${encodeURIComponent(mint)}`,
    ),
  ]);

  if (rugRes.status === 'fulfilled') {
    rug = rugRes.value;
  } else {
    providerErrors.push(`RugCheck: ${rugRes.reason?.message || rugRes.reason}`);
    checks.push({
      id: 'rugcheck',
      ok: false,
      detail: `RugCheck unavailable: ${rugRes.reason?.message || 'error'}`,
      level: 'warn',
    });
  }

  if (goRes.status === 'fulfilled') {
    go = goRes.value;
  } else {
    providerErrors.push(`GoPlus: ${goRes.reason?.message || goRes.reason}`);
    checks.push({
      id: 'goplus',
      ok: false,
      detail: `GoPlus unavailable: ${goRes.reason?.message || 'error'}`,
      level: 'warn',
    });
  }

  // If both providers fail, hard-block LIVE (fail closed) unless allowlisted.
  if (!rug && !go) {
    if (!allowlisted) {
      blockers.push('Rug scanners unreachable — refusing LIVE until scan succeeds');
    }
    return {
      ok: blockers.length === 0,
      providerErrors,
      checks,
      blockers,
      warnings,
      rugcheck: null,
      goplus: null,
    };
  }

  if (rug) {
    if (rug.rugged === true) {
      checks.push({ id: 'rugged', ok: false, detail: 'RugCheck marked this mint as rugged', level: 'danger' });
      blockers.push('Token marked rugged by RugCheck');
    } else {
      checks.push({ id: 'rugged', ok: true, detail: 'Not marked rugged', level: 'info' });
    }

    const scoreN = Number(rug.score_normalised);
    if (Number.isFinite(scoreN)) {
      const ok = allowlisted || scoreN <= MAX_RUG_SCORE;
      checks.push({
        id: 'rugScore',
        ok,
        detail: `RugCheck score ${scoreN} (max ${MAX_RUG_SCORE})`,
        level: ok ? 'info' : 'danger',
      });
      if (!ok) blockers.push(`RugCheck score ${scoreN} exceeds max ${MAX_RUG_SCORE}`);
    }

    const liq = Number(rug.totalMarketLiquidity);
    if (Number.isFinite(liq) && MIN_LIQUIDITY_USD > 0 && !allowlisted) {
      // RugCheck sometimes reports 0 for stables; only enforce when >0 reported or markets exist
      const hasMarkets = Array.isArray(rug.markets) && rug.markets.length > 0;
      if (hasMarkets && liq > 0 && liq < MIN_LIQUIDITY_USD) {
        checks.push({
          id: 'liquidity',
          ok: false,
          detail: `Liquidity $${liq.toFixed(0)} below $${MIN_LIQUIDITY_USD}`,
          level: 'danger',
        });
        blockers.push(`Market liquidity under $${MIN_LIQUIDITY_USD}`);
      } else if (hasMarkets && liq >= MIN_LIQUIDITY_USD) {
        checks.push({
          id: 'liquidity',
          ok: true,
          detail: `Liquidity ~$${liq.toFixed(0)}`,
          level: 'info',
        });
      } else {
        checks.push({
          id: 'liquidity',
          ok: true,
          detail: hasMarkets ? `Liquidity reported $${liq}` : 'No liquidity figure from RugCheck',
          level: 'warn',
        });
      }
    }

    for (const risk of rug.risks || []) {
      const level = String(risk.level || '').toLowerCase();
      const name = risk.name || 'risk';
      const desc = risk.description || name;
      if (DANGER_LEVELS.has(level)) {
        checks.push({ id: `risk:${name}`, ok: false, detail: desc, level: 'danger' });
        blockers.push(desc);
      } else if (level === 'warn' || level === 'warning') {
        checks.push({ id: `risk:${name}`, ok: true, detail: `Warn: ${desc}`, level: 'warn' });
        warnings.push(desc);
      } else {
        checks.push({ id: `risk:${name}`, ok: true, detail: desc, level: level || 'info' });
      }
    }

    // Top holder concentration
    const top = Array.isArray(rug.topHolders) ? rug.topHolders : [];
    if (top.length && !allowlisted) {
      const pct = Number(top[0].pct ?? top[0].percentage ?? top[0].uiAmount);
      // pct may already be 0-100
      let topPct = Number(top[0].pct);
      if (!Number.isFinite(topPct) && top[0].percentage != null) topPct = Number(top[0].percentage);
      if (Number.isFinite(topPct)) {
        if (topPct <= 1) topPct *= 100; // fraction
        const ok = topPct < 40;
        checks.push({
          id: 'topHolder',
          ok,
          detail: `Top holder ~${topPct.toFixed(1)}%`,
          level: ok ? 'info' : 'danger',
        });
        if (!ok) blockers.push(`Top holder concentration ${topPct.toFixed(1)}% is too high`);
      }
    }
  }

  if (go && go.result) {
    const entry =
      go.result[mint] ||
      go.result[mint.toLowerCase()] ||
      Object.values(go.result)[0];
    if (entry) {
      const dangerousFlags = [
        ['non_transferable', 'Token is non-transferable'],
        ['closable', 'Token accounts are closable by authority'],
        ['transfer_hook', 'Transfer hook present (custom transfer logic)'],
      ];
      for (const [key, label] of dangerousFlags) {
        if (statusOn(entry[key])) {
          checks.push({ id: `goplus:${key}`, ok: false, detail: label, level: 'danger' });
          if (!allowlisted) blockers.push(label);
        } else if (entry[key]) {
          checks.push({ id: `goplus:${key}`, ok: true, detail: `${label}: clear`, level: 'info' });
        }
      }
      if (statusOn(entry.freezable) && !allowlisted) {
        checks.push({
          id: 'goplus:freezable',
          ok: false,
          detail: 'GoPlus: freezable by authority',
          level: 'danger',
        });
        blockers.push('GoPlus reports token is freezable');
      } else if (entry.freezable) {
        checks.push({
          id: 'goplus:freezable',
          ok: true,
          detail: allowlisted && statusOn(entry.freezable)
            ? 'GoPlus freezable (allowlisted mint)'
            : 'GoPlus: not freezable',
          level: 'info',
        });
      }
      if (statusOn(entry.mintable)) {
        checks.push({
          id: 'goplus:mintable',
          ok: true,
          detail: 'Warn: GoPlus mintable=true',
          level: 'warn',
        });
        warnings.push('GoPlus: mint authority still active');
      }
      if (entry.trusted_token === '1' || entry.trusted_token === 1) {
        checks.push({ id: 'goplus:trusted', ok: true, detail: 'GoPlus trusted token', level: 'info' });
      }
    }
  }

  return {
    ok: blockers.length === 0,
    providerErrors,
    checks,
    blockers,
    warnings,
    rugcheck: rug
      ? {
          score: rug.score,
          scoreNormalised: rug.score_normalised,
          rugged: rug.rugged,
          totalMarketLiquidity: rug.totalMarketLiquidity,
          totalHolders: rug.totalHolders,
          risks: rug.risks,
        }
      : null,
    goplus: go?.result ? go.result[mint] || Object.values(go.result)[0] : null,
  };
}
