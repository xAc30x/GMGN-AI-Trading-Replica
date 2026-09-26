/**
 * GMGN quote backend — API key + wallet stay on the server only.
 * Server-side LIVE signing is DISABLED: gmgn-cli has no unsigned-tx / wallet-confirm
 * path, so this process must never accept or use GMGN_PRIVATE_KEY.
 * Quotes still need GMGN_LIVE=1, X-GMGN-Token, spend cap, and CA denylist.
 */
import { envNumber } from './config.js';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOL_MINT,
  MAX_SLIPPAGE_BPS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_PRICE_IMPACT_PCT,
  solToLamports,
  clampSlippageBps,
  getQuote as jupiterQuote,
  getSwapTransaction as jupiterSwapTx,
  assertPriceImpactOk,
} from './jupiterSol.js';
import { assessMint, assertMintSafe } from './mintSafety.js';
import { MAX_RUG_SCORE, MIN_LIQUIDITY_USD } from './rugScanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');
const PORT = envNumber('PORT', 8787, { min: 1, max: 65535, integer: true });
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.VITE_SOLANA_RPC_URL ||
  'https://api.mainnet-beta.solana.com';
const RPC_IS_PUBLIC = /api\.mainnet-beta\.solana\.com/i.test(SOLANA_RPC_URL);
const VITE_ORIGIN = 'http://127.0.0.1:5173';

const NATIVE = {
  sol: 'So11111111111111111111111111111111111111112',
  bsc: '0x0000000000000000000000000000000000000000',
  base: '0x0000000000000000000000000000000000000000',
  eth: '0x0000000000000000000000000000000000000000',
};

const CHAIN_MAP = {
  SOL: 'sol',
  BSC: 'bsc',
  Base: 'base',
  ETH: 'eth',
  sol: 'sol',
  bsc: 'bsc',
  base: 'base',
  eth: 'eth',
};

const EXPLORER = {
  sol: (hash) => `https://solscan.io/tx/${hash}`,
  bsc: (hash) => `https://bscscan.com/tx/${hash}`,
  base: (hash) => `https://basescan.org/tx/${hash}`,
  eth: (hash) => `https://etherscan.io/tx/${hash}`,
};

const BOX_SECRETS_PATH = '/home/box/sand-data/box-secrets.json';

/** Demo/placeholder CAs from the UI mock table — never valid LIVE output tokens. */
const BLOCKED_OUTPUT_TOKENS = new Set([
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  '9fQm2aKLp3nR8vW4xY6zH1cD5eF7gJ0iB2kL3pM4nO5q',
  '3HkLp9nQ2wR5tY8uI1oP4aS7dF0gH3jK6lZ9xC2vB5n',
  'B2nX8cP9ZaQ4wE7rT1yU6iO3pA5sD8fG0hJ2kL4mN6v',
  '5tYwRqM8dK3nP6xA9sL2vC5bN8mQ1wE4rT7yU0iO3p',
  '8pLcVzQ4tR7yU1iO3pA6sD9fG2hJ5kL8mN0vB3xC6z',
  '2aDf9bX7mH4kL1nP6qR9sT2vW5yZ8aC0eG3iJ6lN9p',
  '6nKpQsV3yB1xC4zA7sD0fG3hJ6kL9mN2pQ5rT8uW1y',
  '4uRmXeJ1cF8hK2nP5qS7vX0zA3dG6iL9oR2tW5yB8e',
  '1wQsTnH6kD3fG8jL0nP4rT7vY2aC5eH8iK1mO4qS7u',
]);
const BLOCKED_OUTPUT_TOKENS_LC = new Set(
  [...BLOCKED_OUTPUT_TOKENS].map((a) => a.toLowerCase()),
);

const CRED_ENV_KEYS = new Set([
  'GMGN_API_KEY',
  'GMGN_WALLET_ADDRESS',
]);

const DEFAULT_MAX_NATIVE_AMOUNT = 0.05;
const TOKEN_HEADER = 'x-gmgn-token';

/** Load GMGN_* from Grok Bot secret-request store (card) without logging values. */
function loadBoxSecrets() {
  try {
    if (!fs.existsSync(BOX_SECRETS_PATH)) return;
    const data = JSON.parse(fs.readFileSync(BOX_SECRETS_PATH, 'utf8'));
    const card = data?.card || {};
    // Never load GMGN_PRIVATE_KEY — this server does not sign LIVE swaps.
    for (const key of ['GMGN_API_KEY', 'GMGN_WALLET_ADDRESS']) {
      const v = card[key];
      if (typeof v === 'string' && v.trim() && !process.env[key]) {
        process.env[key] = v.trim();
      }
    }
  } catch {
    // ignore malformed store
  }
}

function loadEnvFile() {
  if (fs.existsSync(ENV_PATH)) {
    dotenv.config({ path: ENV_PATH, override: false });
  }
}

/** Drop any persisted OpenAPI signing key — this process never signs. */
function stripPersistedPrivateKey() {
  delete process.env.GMGN_PRIVATE_KEY;
  if (!fs.existsSync(ENV_PATH)) return;
  const parsed = dotenv.parse(fs.readFileSync(ENV_PATH));
  if (!parsed.GMGN_PRIVATE_KEY) return;
  delete parsed.GMGN_PRIVATE_KEY;
  const body =
    Object.entries(parsed)
      .map(([k, v]) => {
        const s = String(v);
        if (/[\r\n]/.test(s)) throw new Error('Credential values cannot contain newlines');
        return `${k}=${JSON.stringify(s)}`;
      })
      .join('\n') + '\n';
  fs.writeFileSync(ENV_PATH, body, { mode: 0o600 });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    /* ignore */
  }
  console.log('Removed GMGN_PRIVATE_KEY from server/.env (server signing disabled).');
}

// Startup-only mutations are performed below, never on import.

function liveEnabled() {
  return process.env.GMGN_LIVE === '1';
}

function getLocalToken() {
  loadEnvFile();
  const fromEnv = process.env.GMGN_LOCAL_TOKEN;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  if (fs.existsSync(ENV_PATH)) {
    const parsed = dotenv.parse(fs.readFileSync(ENV_PATH));
    if (parsed.GMGN_LOCAL_TOKEN) return String(parsed.GMGN_LOCAL_TOKEN).trim();
  }
  return '';
}

function tokensEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function ensureLocalToken() {
  if (getLocalToken()) return;
  const token = crypto.randomBytes(24).toString('base64url');
  writeEnvMerge({ GMGN_LOCAL_TOKEN: token }, { allowKeys: new Set(['GMGN_LOCAL_TOKEN']) });
  process.env.GMGN_LOCAL_TOKEN = token;
  console.log(
    'Generated GMGN_LOCAL_TOKEN into server/.env — paste it in the Credentials panel. Value is not logged.',
  );
}

function getMaxNativeAmount() {
  return envNumber('GMGN_MAX_NATIVE_AMOUNT', DEFAULT_MAX_NATIVE_AMOUNT, { min: 0.000000001 });
}

function isBlockedOutputToken(token) {
  const t = String(token || '').trim();
  if (!t) return true;
  return BLOCKED_OUTPUT_TOKENS.has(t) || BLOCKED_OUTPUT_TOKENS_LC.has(t.toLowerCase());
}

function assertOutputToken(chainKey, token) {
  const t = String(token || '').trim();
  if (!t) {
    throw Object.assign(new Error('outputToken required'), { status: 400 });
  }
  if (isBlockedOutputToken(t)) {
    throw Object.assign(
      new Error('Token address is a demo/placeholder CA and is blocked for LIVE'),
      { status: 400 },
    );
  }
  if (chainKey === 'sol') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) {
      throw Object.assign(new Error('Invalid Solana token address'), { status: 400 });
    }
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(t)) {
    throw Object.assign(new Error('Invalid EVM token address'), { status: 400 });
  }
  return t;
}

function maxSmallest(chainKey) {
  return BigInt(toSmallest(chainKey, getMaxNativeAmount(), null));
}

function assertSpendAmount(chainKey, amtSmallest) {
  let n;
  try {
    n = BigInt(String(amtSmallest));
  } catch {
    throw Object.assign(new Error('Invalid amountSmallest'), { status: 400 });
  }
  if (n <= 0n) {
    throw Object.assign(new Error('Invalid amount'), { status: 400 });
  }
  const cap = maxSmallest(chainKey);
  if (n > cap) {
    throw Object.assign(
      new Error(
        `Amount exceeds GMGN_MAX_NATIVE_AMOUNT (${getMaxNativeAmount()} native; ${cap} smallest units)`,
      ),
      { status: 400 },
    );
  }
  return String(n);
}

function requireLocalToken(req, res, next) {
  const expected = getLocalToken();
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'GMGN_LOCAL_TOKEN is not configured' });
  }
  const hdr = req.get(TOKEN_HEADER) || '';
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = hdr.trim() || bearer.trim();
  if (!tokensEqual(provided, expected)) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing X-GMGN-Token' });
  }
  next();
}

function requireLiveFlag(req, res, next) {
  if (!liveEnabled()) {
    return res.status(403).json({
      ok: false,
      error: 'LIVE disabled on server. Export GMGN_LIVE=1 in the process that runs npm run server.',
    });
  }
  next();
}

let tradeBusy = false;
function withTradeLock(handler) {
  return async (req, res, next) => {
    if (tradeBusy) {
      return res.status(429).json({ ok: false, error: 'A LIVE trade is already in flight' });
    }
    tradeBusy = true;
    try {
      await handler(req, res, next);
    } finally {
      tradeBusy = false;
    }
  };
}

function credStatus() {
  loadEnvFile();
  // Re-read .env into a local object for merged view without leaking
  const fromFile = {};
  if (fs.existsSync(ENV_PATH)) {
    const parsed = dotenv.parse(fs.readFileSync(ENV_PATH));
    Object.assign(fromFile, parsed);
  }
  const apiKey = !!(process.env.GMGN_API_KEY || fromFile.GMGN_API_KEY);
  const wallet = !!(process.env.GMGN_WALLET_ADDRESS || fromFile.GMGN_WALLET_ADDRESS);
  return {
    apiKey,
    privateKey: false,
    wallet,
    walletAddressMasked: maskAddr(
      process.env.GMGN_WALLET_ADDRESS || fromFile.GMGN_WALLET_ADDRESS || '',
    ),
    apiKeySource: process.env.GMGN_API_KEY
      ? 'env'
      : fromFile.GMGN_API_KEY
        ? 'file'
        : 'missing',
    privateKeySource: 'disabled',
  };
}

function maskAddr(addr) {
  if (!addr || addr.length < 10) return addr ? '***' : '';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function getWallet() {
  loadEnvFile();
  if (fs.existsSync(ENV_PATH)) {
    const parsed = dotenv.parse(fs.readFileSync(ENV_PATH));
    return process.env.GMGN_WALLET_ADDRESS || parsed.GMGN_WALLET_ADDRESS || '';
  }
  return process.env.GMGN_WALLET_ADDRESS || '';
}

function resolveCliBin() {
  const local = path.join(__dirname, '..', 'node_modules', '.bin', 'gmgn-cli');
  if (fs.existsSync(local)) return local;
  return null;
}

function cliInstalled() {
  const bin = resolveCliBin();
  return Boolean(bin && fs.existsSync(bin));
}

/**
 * Build env for child: merge process.env + server/.env.
 * NEVER permanently export GMGN_ALLOW_AUTOMATED_TRADES on the parent.
 */
function childEnv(extra = {}) {
  loadEnvFile();
  const merged = { ...process.env };
  if (fs.existsSync(ENV_PATH)) {
    const parsed = dotenv.parse(fs.readFileSync(ENV_PATH));
    for (const [k, v] of Object.entries(parsed)) {
      if (v != null && v !== '') merged[k] = v;
    }
  }
  // Strip accidental permanent allow flag from parent unless this call sets it
  delete merged.GMGN_ALLOW_AUTOMATED_TRADES;
  // Never pass a signing key to gmgn-cli from this process.
  delete merged.GMGN_PRIVATE_KEY;
  Object.assign(merged, extra);
  delete merged.GMGN_PRIVATE_KEY;
  return merged;
}

function runCli(args, { allowAutomated = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const bin = resolveCliBin();
    if (!bin) {
      resolve({
        ok: false,
        code: -1,
        error: 'gmgn-cli not found in node_modules/.bin',
        stdout: '',
        stderr: '',
      });
      return;
    }
    const env = childEnv(
      allowAutomated ? { GMGN_ALLOW_AUTOMATED_TRADES: '1' } : {},
    );
    // Log args only — never secrets
    const safeArgs = args.map((a) =>
      /^(GMGN_|sk-|0x[a-fA-F0-9]{64})/.test(String(a)) ? '[redacted]' : a,
    );
    console.log(`[gmgn-cli] ${bin} ${safeArgs.join(' ')}${allowAutomated ? ' (ALLOW_AUTOMATED=1 for this process)' : ''}`);

    const child = spawn(bin, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        error: err.message,
        stdout,
        stderr,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          // --raw may be single-line JSON; also try last JSON object in output
          parsed = JSON.parse(trimmed);
        } catch {
          const match = trimmed.match(/\{[\s\S]*\}\s*$/);
          if (match) {
            try {
              parsed = JSON.parse(match[0]);
            } catch {
              /* ignore */
            }
          }
        }
      }
      // Never log raw stdout if it might contain secrets — only status fields
      const orderId =
        parsed?.data?.order_id || parsed?.order_id || parsed?.data?.orderId;
      const hash = parsed?.data?.hash || parsed?.hash;
      if (orderId || hash) {
        console.log(`[gmgn-cli] done code=${code} order_id=${orderId || '-'} hash=${hash || '-'}`);
      } else {
        console.log(`[gmgn-cli] done code=${code} bytes_out=${stdout.length}`);
      }
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr: redactSecrets(stderr),
        parsed,
      });
    });
  });
}

function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/GMGN_API_KEY[=:]\S+/gi, 'GMGN_API_KEY=[redacted]')
    .replace(/GMGN_PRIVATE_KEY[=:]\S+/gi, 'GMGN_PRIVATE_KEY=[redacted]')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/g, '[redacted-key]');
}

function mapChain(chain) {
  const c = CHAIN_MAP[chain];
  if (!c) throw Object.assign(new Error(`Unsupported chain: ${chain}`), { status: 400 });
  return c;
}

function toSmallest(chainKey, humanOrSmallest, alreadySmallest) {
  if (alreadySmallest != null && alreadySmallest !== '') {
    return String(alreadySmallest);
  }
  const n = Number(humanOrSmallest);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error('Invalid amount'), { status: 400 });
  }
  if (chainKey === 'sol') {
    // human SOL → lamports
    return String(Math.round(n * 1e9));
  }
  // EVM native: assume 18 decimals for human ETH/BNB
  return String(BigInt(Math.round(n * 1e18)));
}

function quoteEnvValue(v) {
  const s = String(v);
  if (/[\r\n]/.test(s)) {
    throw Object.assign(new Error('Credential values cannot contain newlines'), { status: 400 });
  }
  return JSON.stringify(s);
}

function writeEnvMerge(updates, { allowKeys = CRED_ENV_KEYS } = {}) {
  const existing = fs.existsSync(ENV_PATH)
    ? dotenv.parse(fs.readFileSync(ENV_PATH))
    : {};
  const next = { ...existing };
  for (const [k, v] of Object.entries(updates)) {
    if (v == null || v === '') continue;
    if (!allowKeys.has(k)) {
      throw Object.assign(new Error(`Refusing to write env key ${k}`), { status: 400 });
    }
    const trimmed = String(v).trim();
    if (/[\r\n]/.test(trimmed)) {
      throw Object.assign(new Error('Credential values cannot contain newlines'), { status: 400 });
    }
    next[k] = trimmed;
  }
  const body =
    Object.entries(next)
      .map(([k, v]) => `${k}=${quoteEnvValue(v)}`)
      .join('\n') + '\n';
  fs.writeFileSync(ENV_PATH, body, { mode: 0o600 });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    /* ignore on platforms without chmod */
  }
  for (const [k, v] of Object.entries(next)) {
    if (!process.env[k]) process.env[k] = v;
  }
  if (next.GMGN_WALLET_ADDRESS) {
    process.env.GMGN_WALLET_ADDRESS = next.GMGN_WALLET_ADDRESS;
  }
}

export const app = express();
app.use(
  cors({
    origin: [VITE_ORIGIN, 'http://localhost:5173'],
  }),
);
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', async (_req, res) => {
  const installed = cliInstalled();
  const creds = credStatus();
  const enabled = liveEnabled();
  const tokenConfigured = Boolean(getLocalToken());
  // liveReady = legacy GMGN quote-ready. SOL wallet trading uses solLiveEnabled + wallet.
  const liveReady =
    installed && creds.apiKey && creds.wallet && enabled && tokenConfigured;
  res.json({
    ok: true,
    cliInstalled: installed,
    liveEnabled: enabled,
    solLiveEnabled: enabled,
    tokenConfigured,
    maxNativeAmount: getMaxNativeAmount(),
    maxSlippageBps: MAX_SLIPPAGE_BPS,
    defaultSlippageBps: DEFAULT_SLIPPAGE_BPS,
    maxPriceImpactPct: MAX_PRICE_IMPACT_PCT,
    serverSigningDisabled: true,
    solWalletTrading: true,
    mintSafetyRequired: true,
    maxRugScore: MAX_RUG_SCORE,
    minLiquidityUsd: MIN_LIQUIDITY_USD,
    solanaRpcConfigured: Boolean(process.env.SOLANA_RPC_URL || process.env.VITE_SOLANA_RPC_URL),
    rpcIsPublic: RPC_IS_PUBLIC,
    paperModeSupported: true,
    credentials: {
      apiKey: creds.apiKey,
      privateKey: false,
      wallet: creds.wallet,
      walletAddressMasked: creds.walletAddressMasked,
      apiKeySource: creds.apiKeySource,
      privateKeySource: 'disabled',
    },
    liveReady,
  });
});

app.post('/api/credentials', requireLocalToken, (req, res) => {
  const { walletAddress, apiKey, privateKey } = req.body || {};
  if (privateKey != null && String(privateKey).trim() !== '') {
    return res.status(400).json({
      ok: false,
      error:
        'GMGN_PRIVATE_KEY is rejected: this server does not sign LIVE trades. Use quotes + copy intent, or sign in a wallet outside this app.',
    });
  }
  const updates = {};
  if (typeof walletAddress === 'string' && walletAddress.trim()) {
    updates.GMGN_WALLET_ADDRESS = walletAddress.trim();
  }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    updates.GMGN_API_KEY = apiKey.trim();
  }
  if (updates.GMGN_API_KEY && !liveEnabled()) {
    return res.status(403).json({
      ok: false,
      error: 'Refusing to store API key while GMGN_LIVE is not 1',
    });
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ ok: false, error: 'No credentials provided' });
  }
  try {
    writeEnvMerge(updates);
    stripPersistedPrivateKey();
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
  const creds = credStatus();
  res.json({
    ok: true,
    serverSigningDisabled: true,
    credentials: {
      apiKey: creds.apiKey,
      privateKey: false,
      wallet: creds.wallet,
      walletAddressMasked: creds.walletAddressMasked,
      apiKeySource: creds.apiKeySource,
      privateKeySource: 'disabled',
    },
  });
});

app.post('/api/quote', requireLocalToken, requireLiveFlag, async (req, res) => {
  try {
    const {
      chain,
      inputToken,
      outputToken,
      amountSmallest,
      amount,
      slippage = 30,
    } = req.body || {};
    const chainKey = mapChain(chain);
    const outTok = assertOutputToken(chainKey, outputToken);
    const amt = assertSpendAmount(
      chainKey,
      amountSmallest ? String(amountSmallest) : toSmallest(chainKey, amount, null),
    );
    const wallet = getWallet();
    if (!wallet) {
      return res.status(400).json({ ok: false, error: 'GMGN_WALLET_ADDRESS not configured' });
    }
    const inTok = inputToken || NATIVE[chainKey];
    const result = await runCli(
      [
        'order',
        'quote',
        '--chain',
        chainKey,
        '--from',
        wallet,
        '--input-token',
        inTok,
        '--output-token',
        outTok,
        '--amount',
        amt,
        '--slippage',
        String(slippage),
        '--raw',
      ],
      { allowAutomated: false },
    );
    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        error: result.stderr || result.error || 'quote failed',
        code: result.code,
      });
    }
    const data = result.parsed?.data ?? result.parsed ?? {};
    res.json({
      ok: true,
      chain: chainKey,
      inputToken: inTok,
      outputToken: outTok,
      amountSmallest: amt,
      quote: data,
      outputAmount: data.output_amount,
      minOutputAmount: data.min_output_amount,
      slippage: data.slippage ?? slippage,
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.post(
  '/api/swap',
  requireLocalToken,
  requireLiveFlag,
  (_req, res) => {
    return res.status(410).json({
      ok: false,
      error:
        'Server-side LIVE signing is disabled. gmgn-cli cannot return unsigned txs for wallet confirm. Use /api/quote and complete the trade in a wallet you control (e.g. gmgn.ai).',
      serverSigningDisabled: true,
    });
  },
);

app.get('/api/order', requireLocalToken, requireLiveFlag, async (req, res) => {
  try {
    const chainKey = mapChain(req.query.chain);
    const orderId = req.query.orderId;
    if (!orderId) {
      return res.status(400).json({ ok: false, error: 'orderId required' });
    }
    const result = await runCli(
      ['order', 'get', '--chain', chainKey, '--order-id', String(orderId), '--raw'],
      { allowAutomated: false },
    );
    const data = result.parsed?.data ?? result.parsed ?? {};
    const hash = data.hash;
    const status = data.status || data.confirmation?.state;
    console.log(`[order get] order_id=${orderId} status=${status || '-'} hash=${hash || '-'}`);
    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        error: result.stderr || result.error || 'order get failed',
      });
    }
    res.json({
      ok: true,
      orderId,
      hash,
      status,
      explorerUrl: hash && EXPLORER[chainKey] ? EXPLORER[chainKey](hash) : null,
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.post(
  '/api/close',
  requireLocalToken,
  requireLiveFlag,
  (_req, res) => {
    return res.status(410).json({
      ok: false,
      error:
        'Server-side LIVE close is disabled. This process never holds a signing key. Close the position in your wallet / gmgn.ai.',
      serverSigningDisabled: true,
    });
  },
);


/** Solana Jupiter: quote (unsigned). Requires local token + GMGN_LIVE=1. */
app.post('/api/sol/quote', requireLocalToken, requireLiveFlag, async (req, res) => {
  try {
    const body = req.body || {};
    const outputMint = assertOutputToken('sol', body.outputMint || body.outputToken);
    const inputMint = body.inputMint
      ? assertOutputToken('sol', body.inputMint)
      : SOL_MINT;
    const slippageBps = clampSlippageBps(body.slippageBps);
    const isBuy = inputMint === SOL_MINT;
    let amountAtomic;
    if (body.amountLamports != null && body.amountLamports !== '') {
      amountAtomic = isBuy
        ? assertSpendAmount('sol', String(body.amountLamports))
        : String(BigInt(String(body.amountLamports)));
    } else if (body.amountAtomic != null && body.amountAtomic !== '') {
      amountAtomic = isBuy
        ? assertSpendAmount('sol', String(body.amountAtomic))
        : String(BigInt(String(body.amountAtomic)));
    } else if (isBuy) {
      amountAtomic = assertSpendAmount('sol', String(solToLamports(body.amount)));
    } else {
      throw Object.assign(new Error('amountAtomic required for non-SOL input'), { status: 400 });
    }

    if (isBuy) {
      const safety = await assessMint(outputMint);
      assertMintSafe(safety);
    } else {
      const safety = await assessMint(inputMint);
      assertMintSafe(safety);
    }

    const quote = await jupiterQuote({
      inputMint,
      outputMint,
      amountAtomic,
      slippageBps,
    });
    assertPriceImpactOk(quote);
    res.json({
      ok: true,
      chain: 'sol',
      inputMint,
      outputMint,
      amountAtomic: String(amountAtomic),
      amountLamports: isBuy ? String(amountAtomic) : undefined,
      slippageBps,
      outAmount: quote.outAmount,
      otherAmountThreshold: quote.otherAmountThreshold,
      priceImpactPct: quote.priceImpactPct,
      quote,
    });
  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message,
      details: e.details,
    });
  }
});

/** On-chain mint safety (freeze/mint authority, supply, SPL). */
app.post('/api/sol/mint-safety', requireLocalToken, requireLiveFlag, async (req, res) => {
  try {
    const mint = assertOutputToken('sol', (req.body || {}).mint || (req.body || {}).outputMint);
    const assessment = await assessMint(mint);
    res.json({ ok: assessment.ok, ...assessment });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, details: e.details });
  }
});

/**
 * Solana Jupiter: build unsigned VersionedTransaction (base64) for a buy (SOL → mint).
 * Client wallet must sign. Never holds a private key.
 */
app.post('/api/sol/swap-tx', requireLocalToken, requireLiveFlag, withTradeLock(async (req, res) => {
  try {
    const body = req.body || {};
    if (body.confirm !== true || body.mode !== 'LIVE') {
      return res.status(403).json({
        ok: false,
        error: 'SOL swap-tx rejected: confirm must be true and mode must be LIVE',
      });
    }
    const userPublicKey = String(body.userPublicKey || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(userPublicKey)) {
      return res.status(400).json({ ok: false, error: 'userPublicKey required (base58)' });
    }
    const outputMint = assertOutputToken('sol', body.outputMint || body.outputToken);
    const slippageBps = clampSlippageBps(body.slippageBps);
    let lamports;
    if (body.amountLamports != null && body.amountLamports !== '') {
      lamports = assertSpendAmount('sol', String(body.amountLamports));
    } else {
      lamports = assertSpendAmount('sol', String(solToLamports(body.amount)));
    }

    const safety = await assessMint(outputMint);
    assertMintSafe(safety);

    // Never use a caller's quote: only the exact validated intent reaches Jupiter.
    const quote = await jupiterQuote({
      inputMint: SOL_MINT,
      outputMint,
      amountAtomic: lamports,
      slippageBps,
    });
    assertPriceImpactOk(quote);
    if (quote.inAmount && BigInt(quote.inAmount) > maxSmallest('sol')) {
      return res.status(400).json({ ok: false, error: 'Quote exceeds GMGN_MAX_NATIVE_AMOUNT' });
    }
    const swap = await jupiterSwapTx({ quoteResponse: quote, userPublicKey });
    if (!swap.swapTransaction) {
      return res.status(502).json({ ok: false, error: 'Jupiter did not return swapTransaction' });
    }
    res.json({
      ok: true,
      chain: 'sol',
      side: 'buy',
      swapTransaction: swap.swapTransaction,
      lastValidBlockHeight: swap.lastValidBlockHeight,
      prioritizationFeeLamports: swap.prioritizationFeeLamports,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      otherAmountThreshold: quote.otherAmountThreshold,
      slippageBps,
      outputMint,
      inputMint: SOL_MINT,
      mintSafety: safety,
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, details: e.details });
  }
}));

/**
 * Solana Jupiter: unsigned close (token → SOL). amountAtomic = raw token amount to sell.
 * Optional percent with client-supplied balanceAtomic.
 */
app.post('/api/sol/close-tx', requireLocalToken, requireLiveFlag, withTradeLock(async (req, res) => {
  try {
    const body = req.body || {};
    if (body.confirm !== true || body.mode !== 'LIVE') {
      return res.status(403).json({
        ok: false,
        error: 'SOL close-tx rejected: confirm must be true and mode must be LIVE',
      });
    }
    const userPublicKey = String(body.userPublicKey || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(userPublicKey)) {
      return res.status(400).json({ ok: false, error: 'userPublicKey required (base58)' });
    }
    const inputMint = assertOutputToken('sol', body.inputMint || body.tokenAddress || body.outputToken);
    if (inputMint === SOL_MINT) {
      return res.status(400).json({ ok: false, error: 'Cannot close native SOL as a token position' });
    }
    const slippageBps = clampSlippageBps(body.slippageBps);
    let amountAtomic;
    if (body.amountAtomic != null && body.amountAtomic !== '') {
      amountAtomic = String(BigInt(String(body.amountAtomic)));
    } else if (body.balanceAtomic != null && body.percent != null) {
      const bal = BigInt(String(body.balanceAtomic));
      const pct = Number(body.percent);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        return res.status(400).json({ ok: false, error: 'percent must be 1–100' });
      }
      amountAtomic = String((bal * BigInt(Math.floor(pct * 1000))) / 100000n);
    } else {
      return res.status(400).json({ ok: false, error: 'amountAtomic (or balanceAtomic+percent) required' });
    }
    if (BigInt(amountAtomic) <= 0n) {
      return res.status(400).json({ ok: false, error: 'Sell amount must be > 0' });
    }

    const safety = await assessMint(inputMint);
    assertMintSafe(safety);

    const quote = await jupiterQuote({
      inputMint,
      outputMint: SOL_MINT,
      amountAtomic,
      slippageBps,
    });
    assertPriceImpactOk(quote);
    // Cap expected SOL out by the same native max (prevents dumping huge bags in one click by mistake if mis-sized)
    if (quote.outAmount && BigInt(quote.outAmount) > maxSmallest('sol') * 20n) {
      // allow larger closes than buys (20x cap) but still bound absurd quotes
      return res.status(400).json({
        ok: false,
        error: `Expected SOL out exceeds close bound (${20 * getMaxNativeAmount()} SOL)`,
      });
    }

    const swap = await jupiterSwapTx({ quoteResponse: quote, userPublicKey });
    if (!swap.swapTransaction) {
      return res.status(502).json({ ok: false, error: 'Jupiter did not return swapTransaction' });
    }
    res.json({
      ok: true,
      chain: 'sol',
      side: 'close',
      swapTransaction: swap.swapTransaction,
      lastValidBlockHeight: swap.lastValidBlockHeight,
      prioritizationFeeLamports: swap.prioritizationFeeLamports,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      otherAmountThreshold: quote.otherAmountThreshold,
      slippageBps,
      inputMint,
      outputMint: SOL_MINT,
      amountAtomic,
      mintSafety: safety,
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, details: e.details });
  }
}));



/** Batch mint-safety for watchlist (max 8, sequential to be kind to RugCheck/GoPlus). */
app.post('/api/sol/watchlist-scan', requireLocalToken, requireLiveFlag, async (req, res) => {
  try {
    const body = req.body || {};
    let mints = Array.isArray(body.mints) ? body.mints : [];
    mints = mints
      .map((m) => String(m || '').trim())
      .filter(Boolean);
    // de-dupe
    mints = [...new Set(mints)].slice(0, 8);
    if (mints.length === 0) {
      return res.status(400).json({ ok: false, error: 'mints[] required (1–8)' });
    }
    const results = [];
    for (const mint of mints) {
      try {
        const checked = assertOutputToken('sol', mint);
        const assessment = await assessMint(checked);
        results.push({
          mint: checked,
          ok: assessment.ok,
          blockers: assessment.blockers,
          warnings: assessment.warnings || [],
          checks: assessment.checks,
          decimals: assessment.decimals,
          supply: assessment.supply,
          mintAuthority: assessment.mintAuthority,
          freezeAuthority: assessment.freezeAuthority,
          rug: assessment.rug
            ? {
                ok: assessment.rug.ok,
                warnings: assessment.rug.warnings,
                blockers: assessment.rug.blockers,
                rugcheck: assessment.rug.rugcheck,
              }
            : undefined,
        });
      } catch (e) {
        results.push({
          mint,
          ok: false,
          blockers: [e.message || 'scan failed'],
          warnings: [],
          checks: [],
          mintAuthority: null,
          freezeAuthority: null,
          error: e.message,
        });
      }
    }
    res.json({ ok: true, results, scannedAt: new Date().toISOString() });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadBoxSecrets();
  loadEnvFile();
  stripPersistedPrivateKey();
  ensureLocalToken();
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`GMGN swap server listening on http://127.0.0.1:${PORT}`);
    console.log(`CORS origin: ${VITE_ORIGIN}`);
    console.log(
      `LIVE=${liveEnabled() ? 'on' : 'off'} maxNative=${getMaxNativeAmount()} token=${getLocalToken() ? 'set' : 'missing'}`,
    );
    const c = credStatus();
    console.log(
      `Credentials: apiKey=${c.apiKey} wallet=${c.wallet} (${c.walletAddressMasked || 'none'}) serverSigning=disabled`,
    );
  });

}
