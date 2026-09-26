/**
 * Full-ish rug / honeypot scan via RugCheck + GoPlus (public endpoints).
 * Merges into mint-safety: danger findings become blockers.
 */
import { envNumber } from './config.js';

const RUGCHECK_BASE = process.env.RUGCHECK_API_BASE || 'https://api.rugcheck.xyz/v1';
const GOPLUS_BASE = process.env.GOPLUS_API_BASE || 'https://api.gopluslabs.io/api/v1';
/** RugCheck score_normalised above this blocks (higher = riskier). */
export const MAX_RUG_SCORE = envNumber('GMGN_MAX_RUG_SCORE', 40, { min: 0, max: 100 });
/** Min USD market liquidity from RugCheck (0 disables). */
export const MIN_LIQUIDITY_USD = envNumber('GMGN_MIN_LIQUIDITY_USD', 1000, { min: 0 });

const AUTHORITY_ALLOWLIST = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'So11111111111111111111111111111111111111112',
]);

const DANGER_LEVELS = new Set(['danger', 'critical', 'severe', 'error']);
const RISK_LEVELS = new Set([...DANGER_LEVELS, 'warn', 'warning', 'info']);

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
      throw new Error('Invalid scanner JSON');
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

function flagValue(field) {
  // GoPlus reports transfer_hook as a list of hook programs: empty means none.
  if (Array.isArray(field)) return field.length > 0;
  const v = field && typeof field === 'object' ? field.status : field;
  if (v === true || v === 1 || v === '1') return true;
  if (v === false || v === 0 || v === '0') return false;
  throw new Error('Missing or invalid GoPlus status');
}
function statusOn(field) { return flagValue(field); }

const finiteNumber = (n) => typeof n === 'number' && Number.isFinite(n);
export function validateRugReport(data, mint) {
  if (!data || data.error || data.mint !== mint || typeof data.rugged !== 'boolean' ||
      !finiteNumber(data.score_normalised) || data.score_normalised < 0 || data.score_normalised > 100 ||
      !Array.isArray(data.risks) || !data.risks.every(r =>
        r && typeof r.name === 'string' && typeof r.level === 'string' &&
        RISK_LEVELS.has(r.level.trim().toLowerCase())) ||
      !Array.isArray(data.topHolders) || !data.topHolders.every(h =>
        h && finiteNumber(h.pct) && h.pct >= 0 && h.pct <= 100)) {
    throw new Error('Invalid or wrong-mint RugCheck report');
  }
  return data;
}
export function validateGoReport(data, mint) {
  const entry = data?.result?.[mint];
  if (data?.code !== 1 || !entry || typeof entry !== 'object') {
    throw new Error('Missing or wrong-mint GoPlus report');
  }
  for (const key of ['non_transferable', 'closable', 'transfer_hook', 'freezable', 'mintable']) {
    flagValue(entry[key]);
  }
  return data;
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
    fetchJson(`${RUGCHECK_BASE}/tokens/${encodeURIComponent(mint)}/report`).then(data => validateRugReport(data, mint)),
    fetchJson(
      `${GOPLUS_BASE}/solana/token_security?contract_addresses=${encodeURIComponent(mint)}`,
    ).then(data => validateGoReport(data, mint)),
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

  if (MIN_LIQUIDITY_USD > 0 && !allowlisted) {
    const liq = rug?.totalMarketLiquidity;
    const ok = finiteNumber(liq) && liq >= MIN_LIQUIDITY_USD;
    const detail = ok ? 'Liquidity $' + liq : 'Liquidity missing or under $' + MIN_LIQUIDITY_USD;
    checks.push({ id: 'liquidity', ok, detail, level: ok ? 'info' : 'danger' });
    if (!ok) blockers.push(detail);
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

    for (const risk of rug.risks || []) {
      const level = String(risk.level || '').trim().toLowerCase();
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
      // RugCheck pct is already percentage points, never a fraction.
      const topPct = Math.max(...top.map(h => h.pct));
      if (Number.isFinite(topPct)) {
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
    const entry = go.result[mint];
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
    goplus: go?.result?.[mint] || null,
  };
}
