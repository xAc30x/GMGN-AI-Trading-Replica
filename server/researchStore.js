import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const DEFAULT_PATH = fileURLToPath(new URL('./.research.sqlite', import.meta.url));
export const HORIZONS = [5 * 60_000, 60 * 60_000, 24 * 60 * 60_000];
export const OUTCOME_GRACE_MS = 120_000;

// No connection, filesystem writes or timers at import time. All writes are atomic.
export function withResearch(fn) {
  const file = process.env.GMGN_RESEARCH_DB_PATH || DEFAULT_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600);
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS scans (id TEXT PRIMARY KEY, at INTEGER NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id), mint TEXT NOT NULL,
        at INTEGER NOT NULL, decision TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observations_time ON observations(at DESC);
      CREATE INDEX IF NOT EXISTS observations_mint ON observations(mint, at DESC);
      CREATE TABLE IF NOT EXISTS outcomes (
        observation_id TEXT NOT NULL REFERENCES observations(id), horizon INTEGER NOT NULL,
        due INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', observed_at INTEGER,
        price_usd REAL, return_pct REAL, error TEXT,
        PRIMARY KEY(observation_id, horizon));
      CREATE INDEX IF NOT EXISTS outcomes_due ON outcomes(status, due);
      CREATE TABLE IF NOT EXISTS paper_account (id INTEGER PRIMARY KEY CHECK(id=1), initial TEXT NOT NULL, cash TEXT NOT NULL);
      INSERT OR IGNORE INTO paper_account VALUES (1, '1000000000', '1000000000');
      CREATE TABLE IF NOT EXISTS paper_positions (
        id TEXT PRIMARY KEY, mint TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, position_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL);
    `);
    // Add account scopes without discarding the existing manual portfolio.
    if (db.prepare('PRAGMA user_version').get().user_version < 2) {
      transaction(db, () => {
        if (!db.prepare('PRAGMA table_info(paper_positions)').all().some(c => c.name === 'account_id')) {
          db.exec("ALTER TABLE paper_positions ADD COLUMN account_id TEXT NOT NULL DEFAULT 'manual'");
        }
        if (!db.prepare('PRAGMA table_info(paper_events)').all().some(c => c.name === 'account_id')) {
          db.exec("ALTER TABLE paper_events ADD COLUMN account_id TEXT NOT NULL DEFAULT 'manual'");
        }
        db.exec(`DROP INDEX IF EXISTS paper_open_mint;
          CREATE UNIQUE INDEX IF NOT EXISTS paper_open_account_mint ON paper_positions(account_id, mint) WHERE state='open';
          PRAGMA user_version=2;`);
      });
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS experiment_accounts (id TEXT PRIMARY KEY, initial TEXT NOT NULL, cash TEXT NOT NULL, started_at INTEGER NOT NULL, manifest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_settings (id INTEGER PRIMARY KEY CHECK(id=1), scanning INTEGER NOT NULL, auto_paper INTEGER NOT NULL);
      INSERT OR IGNORE INTO research_settings VALUES (1, 1, 0);
      CREATE TABLE IF NOT EXISTS research_jobs (source TEXT PRIMARY KEY, next_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, owner TEXT, failures INTEGER NOT NULL DEFAULT 0, last_at INTEGER, last_scan_id TEXT, last_error TEXT);
      CREATE TABLE IF NOT EXISTS strategy_decisions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, scan_id TEXT NOT NULL, at INTEGER NOT NULL, mint TEXT, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS experiment_equity (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, at INTEGER NOT NULL, equity TEXT);
      CREATE INDEX IF NOT EXISTS experiment_equity_account ON experiment_equity(account_id, at);
    `);
    return fn(db);
  } finally { db.close(); }
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function recordScan(source, tokens, at = Date.now()) {
  return withResearch(db => transaction(db, () => {
    const scanId = randomUUID();
    db.prepare('INSERT INTO scans VALUES (?, ?, ?)').run(scanId, at, source);
    for (const token of tokens) {
      const id = randomUUID();
      const decision = token.safety.ok ? 'eligible' : 'blocked';
      db.prepare('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, scanId, token.mint, at, decision, JSON.stringify({ ...token, strategyVersion: token.ranking?.version || 'safety-only-v1' }));
      for (const horizon of HORIZONS) {
        const valid = Number.isFinite(token.priceUsd) && token.priceUsd > 0;
        db.prepare('INSERT INTO outcomes (observation_id, horizon, due, status, error) VALUES (?, ?, ?, ?, ?)')
          .run(id, horizon, at + horizon, valid ? 'pending' : 'unavailable', valid ? null : 'No entry market price');
      }
    }
    return scanId;
  }));
}

export function scanHistory(limit = 50, before = Number.MAX_SAFE_INTEGER, beforeId = '~') {
  return withResearch(db => ({
    totals: db.prepare(`SELECT COUNT(*) AS observations, SUM(decision='eligible') AS eligible,
      SUM(decision='blocked') AS blocked FROM observations`).get(),
    outcomeCounts: db.prepare('SELECT status, COUNT(*) AS count FROM outcomes GROUP BY status').all(),
    rows: db.prepare(`SELECT o.*, s.source FROM observations o JOIN scans s ON s.id=o.scan_id
      WHERE o.at < ? OR (o.at = ? AND o.id < ?) ORDER BY o.at DESC, o.id DESC LIMIT ?`).all(before, before, beforeId, limit).map(row => ({
      id: row.id, scanId: row.scan_id, at: row.at, source: row.source, decision: row.decision,
      ...JSON.parse(row.data),
      outcomes: db.prepare(`SELECT horizon, status, observed_at AS observedAt, price_usd AS priceUsd,
        return_pct AS returnPct, error FROM outcomes WHERE observation_id=? ORDER BY horizon`).all(row.id),
    })),
  }));
}

// Late observations are explicitly missed; no historical prices are fabricated after downtime.
export async function collectOutcomes(fetchPrices, now = () => Date.now()) {
  const due = withResearch(db => {
    db.prepare("UPDATE outcomes SET status='missed', error='Observation window missed' WHERE status='pending' AND due < ?")
      .run(now() - OUTCOME_GRACE_MS);
    return db.prepare(`SELECT x.*, o.mint, o.data FROM outcomes x JOIN observations o ON o.id=x.observation_id
      WHERE x.status='pending' AND x.due<=? ORDER BY x.due LIMIT 300`).all(now());
  });
  const mints = [...new Set(due.map(row => row.mint))].slice(0, 30);
  if (!mints.length) return;
  let prices = {}; let error = null;
  try { prices = await fetchPrices(mints); } catch (e) { error = e.message; }
  const at = now();
  withResearch(db => transaction(db, () => {
    for (const row of due.filter(r => mints.includes(r.mint))) {
      const price = prices[row.mint];
      const late = at > row.due + OUTCOME_GRACE_MS;
      const valid = Number.isFinite(price) && price > 0 && !late;
      db.prepare(`UPDATE outcomes SET status=?, observed_at=?, price_usd=?, return_pct=?, error=?
        WHERE observation_id=? AND horizon=? AND status='pending'`).run(
        late ? 'missed' : valid ? 'observed' : 'pending', valid ? at : null, valid ? price : null,
        valid ? (price / JSON.parse(row.data).priceUsd - 1) * 100 : null,
        late ? 'Observation window missed' : valid ? null : error || 'Market price unavailable', row.observation_id, row.horizon);
    }
  }));
}
