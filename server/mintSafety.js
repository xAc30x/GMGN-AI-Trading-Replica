/**
 * Basic on-chain mint safety checks for Solana SPL tokens.
 * On-chain authority checks + RugCheck/GoPlus rug scan.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { scanRug } from './rugScanner.js';

const RPC =
  process.env.SOLANA_RPC_URL ||
  process.env.VITE_SOLANA_RPC_URL ||
  'https://api.mainnet-beta.solana.com';

let connection;

/** Known reputable mints that may retain freeze/mint authorities (e.g. Circle USDC). */
const AUTHORITY_ALLOWLIST = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112', // wSOL
]);


function getConnection() {
  if (!connection) connection = new Connection(RPC, 'confirmed');
  return connection;
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   mint: string,
 *  checks: Array<{ id: string, ok: boolean, detail: string }>,
 *   decimals?: number,
 *   supply?: string,
 *   mintAuthority: string | null,
 *   freezeAuthority: string | null,
 *   blockers: string[],
 * }>}
 */
export async function assessMint(mintAddress) {
  const mint = String(mintAddress || '').trim();
  const checks = [];
  const blockers = [];

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return {
      ok: false,
      mint,
      checks: [{ id: 'format', ok: false, detail: 'Invalid mint address' }],
      mintAuthority: null,
      freezeAuthority: null,
      blockers: ['Invalid mint address'],
    };
  }

  let parsed;
  try {
    const info = await getConnection().getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    if (!info.value) {
      checks.push({ id: 'exists', ok: false, detail: 'Mint account not found on-chain' });
      blockers.push('Mint account not found on-chain');
      return {
        ok: false,
        mint,
        checks,
        mintAuthority: null,
        freezeAuthority: null,
        blockers,
      };
    }
    const data = info.value.data;
    if (!data || typeof data !== 'object' || !('parsed' in data)) {
      checks.push({ id: 'spl', ok: false, detail: 'Not a parsed SPL mint account' });
      blockers.push('Not a parsed SPL mint account');
      return {
        ok: false,
        mint,
        checks,
        mintAuthority: null,
        freezeAuthority: null,
        blockers,
      };
    }
    if (data.program !== 'spl-token' && data.program !== 'spl-token-2022') {
      checks.push({
        id: 'program',
        ok: false,
        detail: `Unexpected owner program: ${data.program}`,
      });
      blockers.push(`Unexpected token program: ${data.program}`);
    } else {
      checks.push({ id: 'program', ok: true, detail: data.program });
    }
    parsed = data.parsed?.info;
    if (!parsed) {
      checks.push({ id: 'parse', ok: false, detail: 'Missing mint info' });
      blockers.push('Missing mint info');
      return {
        ok: false,
        mint,
        checks,
        mintAuthority: null,
        freezeAuthority: null,
        blockers,
      };
    }
    checks.push({ id: 'exists', ok: true, detail: 'Mint account found' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      mint,
      checks: [{ id: 'rpc', ok: false, detail: msg }],
      mintAuthority: null,
      freezeAuthority: null,
      blockers: [`RPC error: ${msg}`],
    };
  }

  const mintAuthority = parsed.mintAuthority ?? null;
  const freezeAuthority = parsed.freezeAuthority ?? null;
  const decimals = parsed.decimals;
  const supply = String(parsed.supply ?? '');

  const allowlisted = AUTHORITY_ALLOWLIST.has(mint);
  if (freezeAuthority) {
    if (allowlisted) {
      checks.push({
        id: 'freezeAuthority',
        ok: true,
        detail: `Allowlisted mint with freeze authority (${String(freezeAuthority).slice(0, 4)}…)`,
      });
    } else {
      checks.push({
        id: 'freezeAuthority',
        ok: false,
        detail: `Freeze authority set (${String(freezeAuthority).slice(0, 4)}…)`,
      });
      blockers.push('Freeze authority is set — tokens can be frozen');
    }
  } else {
    checks.push({ id: 'freezeAuthority', ok: true, detail: 'No freeze authority' });
  }

  // Mint authority is common (e.g. USDC) and on many memes — warn, do not hard-block.
  if (mintAuthority) {
    checks.push({
      id: 'mintAuthority',
      ok: true,
      detail: `Warn: mint authority still set (${String(mintAuthority).slice(0, 4)}…)`,
    });
  } else {
    checks.push({ id: 'mintAuthority', ok: true, detail: 'Mint authority revoked' });
  }

  if (typeof decimals === 'number' && decimals >= 0 && decimals <= 18) {
    checks.push({ id: 'decimals', ok: true, detail: `decimals=${decimals}` });
  } else {
    checks.push({ id: 'decimals', ok: false, detail: 'Invalid decimals' });
    blockers.push('Invalid mint decimals');
  }

  if (supply === '' || supply === '0') {
    checks.push({ id: 'supply', ok: false, detail: 'Zero or missing supply' });
    blockers.push('Token supply is zero');
  } else {
    checks.push({ id: 'supply', ok: true, detail: `supply=${supply}` });
  }

  let rug = null;
  try {
    rug = await scanRug(mint);
    for (const c of rug.checks || []) checks.push(c);
    for (const b of rug.blockers || []) blockers.push(b);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ id: 'rugScan', ok: false, detail: `Rug scan failed: ${msg}` });
    if (!AUTHORITY_ALLOWLIST.has(mint)) {
      blockers.push(`Rug scan failed: ${msg}`);
    }
  }

  return {
    ok: blockers.length === 0,
    mint,
    checks,
    decimals,
    supply,
    mintAuthority,
    freezeAuthority,
    blockers,
    warnings: rug?.warnings || [],
    rug,
  };
}

export function assertMintSafe(assessment) {
  if (!assessment?.ok) {
    const err = new Error(
      (assessment?.blockers && assessment.blockers[0]) || 'Mint failed safety checks',
    );
    err.status = 400;
    err.details = assessment;
    throw err;
  }
}
