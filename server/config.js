import dotenv from 'dotenv';
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
