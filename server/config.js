import dotenv from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load before any module captures configuration. Importing never writes secrets.
dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)), quiet: true });

export function envNumber(name, fallback, { min = 0, max = Infinity, integer = false } = {}) {
  const raw = process.env[name];
  const n = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error('Invalid configuration: ' + name);
  }
  return n;
}

/** Keys the optional secrets file may set. GMGN_PRIVATE_KEY is never loaded: this server does not sign. */
const SECRETS_FILE_KEYS = ['GMGN_API_KEY', 'GMGN_WALLET_ADDRESS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

/**
 * Location of the optional secrets file: GMGN_SECRETS_PATH when set, otherwise
 * ~/.config/gmgn-trader/secrets.json. A custom path must be absolute or start with ~/.
 */
export function secretsFilePath(env = process.env, home = os.homedir()) {
  const raw = (env.GMGN_SECRETS_PATH ?? '').trim();
  if (raw === '') return path.join(home, '.config', 'gmgn-trader', 'secrets.json');
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  if (!path.isAbsolute(raw)) {
    throw new Error('Invalid configuration: GMGN_SECRETS_PATH must be absolute or start with ~/');
  }
  return path.normalize(raw);
}

/**
 * Copy SECRETS_FILE_KEYS from the secrets file's "card" object into env,
 * without overriding values already set. A missing file is normal. An unreadable or malformed
 * file is skipped with a warning that names the path only, never the file's contents.
 */
export function loadSecretsFile(filePath, env = process.env, warn = console.warn) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    const reason = typeof err?.code === 'string' ? err.code : 'invalid JSON';
    warn(`Ignoring secrets file ${filePath} (${reason}).`);
    return;
  }
  const card = data?.card;
  if (card == null || typeof card !== 'object') {
    warn(`Ignoring secrets file ${filePath} (no "card" object).`);
    return;
  }
  for (const key of SECRETS_FILE_KEYS) {
    const v = card[key];
    if (typeof v === 'string' && v.trim() && !env[key]) {
      env[key] = v.trim();
    }
  }
}
