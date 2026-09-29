import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '.trade-ledger.json');

function ledgerPath() {
  return process.env.GMGN_TRADE_LEDGER_PATH || DEFAULT_PATH;
}

function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function writeLedger(ledger) {
  const file = ledgerPath();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ignore unsupported chmod */ }
}

export function claimBroadcast(tradeId, transactionBase64) {
  if (typeof tradeId !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(tradeId)) {
    return { kind: 'invalid', error: 'X-GMGN-Trade-Id must be a unique 12–128 character identifier' };
  }
  if (typeof transactionBase64 !== 'string' || transactionBase64.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(transactionBase64)) {
    return { kind: 'invalid', error: 'sendTransaction requires a base64 signed transaction' };
  }
  const hash = crypto.createHash('sha256').update(transactionBase64).digest('hex');
  const ledger = readLedger();
  const existing = ledger[tradeId];
  if (existing) {
    if (existing.transactionHash !== hash) return { kind: 'conflict' };
    if (existing.state === 'accepted') return { kind: 'cached', signature: existing.signature };
    return { kind: 'pending' };
  }
  ledger[tradeId] = { transactionHash: hash, state: 'pending', createdAt: Date.now() };
  writeLedger(ledger);
  return { kind: 'claimed' };
}

export function completeBroadcast(tradeId, { signature, failed = false } = {}) {
  const ledger = readLedger();
  const entry = ledger[tradeId];
  if (!entry) return;
  ledger[tradeId] = {
    ...entry,
    state: failed ? 'failed' : 'accepted',
    ...(signature ? { signature } : {}),
    updatedAt: Date.now(),
  };
  writeLedger(ledger);
}