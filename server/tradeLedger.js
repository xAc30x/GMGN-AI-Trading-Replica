import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const DEFAULT_LEGACY = fileURLToPath(new URL('./.trade-ledger.json', import.meta.url));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
export function assertTradeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(id)) fail('Unique 12–128 character tradeId required', 400);
}
function transaction(text) {
  if (typeof text !== 'string' || !text.length || text.length > 1644 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    fail('Canonical base64 Solana transaction required', 400);
  }
  try {
    const bytes = Buffer.from(text, 'base64');
    const tx = VersionedTransaction.deserialize(bytes);
    if (bytes.length > 1232 || encode(tx) !== text || tx.message.version !== 0 ||
        tx.message.header.numRequiredSignatures !== 1 || tx.signatures.length !== 1) {
      fail('Unsupported or noncanonical transaction', 400);
    }
    return tx;
  } catch (error) { fail(`Invalid transaction: ${error.message}`, 400); }
}
const encode = tx => Buffer.from(tx.serialize()).toString('base64');

// A single durable SQLite claim covers all processes using this local filesystem.
// No lock is held over a network await. Uncertain claims are never auto-released.
function withLedger(action) {
  const legacy = process.env.GMGN_TRADE_LEDGER_PATH || DEFAULT_LEGACY;
  const file = `${legacy}.sqlite`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  let begun = false;
  try {
    fs.chmodSync(file, 0o600);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    begun = true;
    db.exec(`CREATE TABLE IF NOT EXISTS authorizations (
      trade_id TEXT PRIMARY KEY, message_hash TEXT NOT NULL UNIQUE,
      wallet TEXT NOT NULL, side TEXT NOT NULL, intent TEXT NOT NULL,
      expiry INTEGER NOT NULL, created_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'ready', payload_hash TEXT,
      signature TEXT UNIQUE, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_claims (
      trade_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, signature TEXT
    );`);
    if (db.prepare('PRAGMA user_version').get().user_version === 0) {
      if (fs.existsSync(legacy)) {
        const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        if (!old || typeof old !== 'object' || Array.isArray(old)) fail('Invalid legacy broadcast ledger', 503);
        const insert = db.prepare('INSERT INTO legacy_claims VALUES (?, ?, ?)');
        for (const [id, entry] of Object.entries(old)) {
          assertTradeId(id);
          if (!entry || !/^[a-f0-9]{64}$/.test(entry.transactionHash) ||
              !['pending', 'accepted', 'failed'].includes(entry.state) ||
              (entry.signature != null && typeof entry.signature !== 'string')) fail('Invalid legacy broadcast claim', 503);
          insert.run(id, entry.transactionHash, entry.signature ?? null);
        }
      }
      db.exec('PRAGMA user_version=1');
    }
    const result = action(db);
    db.exec('COMMIT');
    begun = false;
    return result;
  } finally {
    if (begun) { try { db.exec('ROLLBACK'); } catch { /* retain original error */ } }
    db.close();
  }
}

export function authorizeBroadcast({ tradeId, swapTransaction, walletAddress, side, mode, lastValidBlockHeight, intent }) {
  assertTradeId(tradeId);
  if (mode !== 'LIVE' || !['buy', 'close'].includes(side)) fail('Only LIVE builds can authorize broadcast', 400);
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1) fail('Invalid transaction expiry', 502);
  const tx = transaction(swapTransaction);
  if (tx.message.staticAccountKeys[0].toBase58() !== walletAddress ||
      tx.signatures[0].some(byte => byte !== 0)) fail('Build must be unsigned and require exactly the requested wallet', 502);
  const messageHash = hash(tx.message.serialize());
  withLedger(db => {
    if (db.prepare('SELECT 1 FROM legacy_claims WHERE trade_id=?').get(tradeId) ||
        db.prepare('SELECT 1 FROM authorizations WHERE trade_id=? OR message_hash=?').get(tradeId, messageHash)) {
      fail('Trade ID or transaction already authorized; reconcile instead of rebuilding');
    }
    const now = Date.now();
    db.prepare(`INSERT INTO authorizations
      (trade_id,message_hash,wallet,side,intent,expiry,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(tradeId, messageHash, walletAddress, side, JSON.stringify(intent), lastValidBlockHeight, now, now);
  });
}

export function inspectBroadcast(tradeId, transactionBase64) {
  assertTradeId(tradeId);
  const tx = transaction(transactionBase64);
  const message = tx.message.serialize();
  const signatureBytes = tx.signatures[0];
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), tx.message.staticAccountKeys[0].toBuffer()]),
    format: 'der', type: 'spki',
  });
  if (!crypto.verify(null, message, publicKey, signatureBytes)) fail('Signed transaction signature is invalid', 400);
  const candidate = { tradeId, messageHash: hash(message), payloadHash: hash(transactionBase64),
    signature: bs58.encode(signatureBytes), wallet: tx.message.staticAccountKeys[0].toBase58() };
  return withLedger(db => check(db, candidate));
}
function check(db, candidate) {
  const { tradeId, messageHash, payloadHash, signature, wallet } = candidate;
  if (db.prepare('SELECT 1 FROM legacy_claims WHERE trade_id=? OR payload_hash=? OR signature=?')
    .get(tradeId, payloadHash, signature)) fail('Legacy broadcast requires reconciliation; replay is blocked');
  const row = db.prepare('SELECT * FROM authorizations WHERE trade_id=?').get(tradeId);
  if (!row || row.message_hash !== messageHash || row.wallet !== wallet) fail('Signed transaction does not match a LIVE server authorization');
  if (db.prepare('SELECT 1 FROM authorizations WHERE signature=? AND trade_id<>?').get(signature, tradeId)) fail('Signature already claimed by another trade');
  if (row.payload_hash && row.payload_hash !== payloadHash) fail('Trade ID already used with different signed bytes');
  if (row.state === 'accepted') return { ...candidate, kind: 'cached', side: row.side, intent: JSON.parse(row.intent) };
  if (row.state !== 'ready') fail('Trade is pending or uncertain; reconcile before retrying');
  return { ...candidate, kind: 'ready', expiry: row.expiry, side: row.side, intent: JSON.parse(row.intent) };
}
export function claimBroadcast(candidate, currentBlockHeight) {
  if (!Number.isSafeInteger(currentBlockHeight) || currentBlockHeight < 1) fail('Fresh block height unavailable', 503);
  return withLedger(db => {
    const checked = check(db, candidate);
    if (checked.kind === 'cached') return checked;
    if (currentBlockHeight > checked.expiry) fail('Authorized transaction expired; rebuild with a new trade ID');
    db.prepare("UPDATE authorizations SET state='pending',payload_hash=?,signature=?,updated_at=? WHERE trade_id=?")
      .run(candidate.payloadHash, candidate.signature, Date.now(), candidate.tradeId);
    return { ...checked, kind: 'claimed' };
  });
}
export function completeBroadcast(tradeId, signature) {
  return withLedger(db => {
    const row = db.prepare('SELECT * FROM authorizations WHERE trade_id=?').get(tradeId);
    if (!row || row.state !== 'pending' || row.signature !== signature) fail('RPC signature mismatch; authorization remains uncertain', 502);
    db.prepare("UPDATE authorizations SET state='accepted',updated_at=? WHERE trade_id=?").run(Date.now(), tradeId);
  });
}
