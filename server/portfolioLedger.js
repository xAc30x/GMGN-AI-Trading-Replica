import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PublicKey } from '@solana/web3.js';
import { SOL_MINT, getQuote } from './jupiterSol.js';

const TOKEN_PROGRAMS = [
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
];
const MAX_STALE_SLOTS = 150;
const ABANDONED_BUILD_MS = 120_000;
const SERVER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(SERVER_DIRECTORY, '.portfolio-ledger.sqlite');
const LEGACY_PATH = path.join(SERVER_DIRECTORY, '.portfolio-ledger.json');
const PROCESS_LOCKS = new Map();

function ledgerPath() {
  return process.env.GMGN_PORTFOLIO_LEDGER_PATH || DEFAULT_PATH;
}

function readLegacyReservations(file) {
  try {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || !Array.isArray(ledger.reservations)) {
      throw new Error('Legacy portfolio ledger has an invalid format');
    }
    return ledger.reservations;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function createDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    database.close();
    throw error;
  }
  database.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  return database;
}

async function beginImmediate(database) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      database.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      if (![5, 6].includes(error?.errcode) || Date.now() >= deadline) {
        if ([5, 6].includes(error?.errcode)) {
          throw Object.assign(new Error('Portfolio ledger is busy; retry after reconciliation'), { status: 503 });
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function ensureSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_reservations (
      trade_id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      mint TEXT NOT NULL,
      amount_lamports TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_valid_block_height INTEGER,
      signature TEXT
    );
    CREATE INDEX IF NOT EXISTS portfolio_reservations_wallet
      ON portfolio_reservations(wallet_address);
  `);
}

function readLedger(database) {
  const reservations = database.prepare(`
    SELECT trade_id AS tradeId, wallet_address AS walletAddress, mint,
      amount_lamports AS amountLamports, created_at AS createdAt,
      last_valid_block_height AS lastValidBlockHeight, signature
    FROM portfolio_reservations
  `).all();
  return { reservations };
}

function writeLedger(database, ledger) {
  database.exec('DELETE FROM portfolio_reservations');
  const insert = database.prepare(`
    INSERT INTO portfolio_reservations (
      trade_id, wallet_address, mint, amount_lamports, created_at,
      last_valid_block_height, signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const reservation of ledger.reservations) {
    insert.run(
      reservation.tradeId,
      reservation.walletAddress,
      reservation.mint,
      reservation.amountLamports,
      reservation.createdAt,
      reservation.lastValidBlockHeight ?? null,
      reservation.signature ?? null,
    );
  }
}

async function withLedgerLock(action) {
  const file = path.resolve(ledgerPath());
  const previous = PROCESS_LOCKS.get(file) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  PROCESS_LOCKS.set(file, current);
  await previous;

  let database;
  let transactionStarted = false;
  try {
    database = createDatabase(file);
    await beginImmediate(database);
    transactionStarted = true;
    ensureSchema(database);
    const version = database.prepare('PRAGMA user_version').get().user_version;
    if (version < 1) {
      const legacyPath = process.env.GMGN_PORTFOLIO_LEGACY_PATH
        ? path.resolve(process.env.GMGN_PORTFOLIO_LEGACY_PATH)
        : file === path.resolve(DEFAULT_PATH) ? LEGACY_PATH : null;
      if (legacyPath) {
        const legacyReservations = readLegacyReservations(legacyPath);
        if (legacyReservations.length > 0 && database.prepare('SELECT COUNT(*) AS count FROM portfolio_reservations').get().count === 0) {
          for (const reservation of legacyReservations) {
            if (!reservation || typeof reservation.tradeId !== 'string' ||
                !/^[A-Za-z0-9_-]{12,128}$/.test(reservation.tradeId) ||
                typeof reservation.walletAddress !== 'string' || !reservation.walletAddress ||
                typeof reservation.mint !== 'string' || !reservation.mint ||
                typeof reservation.amountLamports !== 'string' || !/^\d+$/.test(reservation.amountLamports) ||
                !Number.isSafeInteger(reservation.createdAt) ||
                (reservation.signature != null && typeof reservation.signature !== 'string') ||
                (reservation.lastValidBlockHeight != null && !Number.isSafeInteger(reservation.lastValidBlockHeight))) {
              throw new Error('Legacy portfolio ledger contains an invalid reservation');
            }
          }
          database.exec('PRAGMA user_version = 1');
          writeLedger(database, { reservations: legacyReservations });
        }
      }
      database.exec('PRAGMA user_version = 1');
    }
    const ledger = readLedger(database);
    const result = await action(ledger);
    writeLedger(database, ledger);
    database.exec('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try { database.exec('ROLLBACK'); } catch { /* retain original error */ }
    }
    throw error;
  } finally {
    database?.close();
    release();
    if (PROCESS_LOCKS.get(file) === current) PROCESS_LOCKS.delete(file);
  }
}

function parseHoldings(accounts) {
  const holdings = new Map();
  for (const account of accounts.value || []) {
    const info = account.account?.data?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    const decimals = info?.tokenAmount?.decimals;
    const mint = info?.mint;
    if (typeof mint !== 'string' || typeof amount !== 'string' || !/^\d+$/.test(amount) ||
        !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw Object.assign(new Error('Token account data is unavailable or malformed'), { status: 503 });
    }
    const quantity = BigInt(amount);
    if (quantity === 0n || mint === SOL_MINT) continue;
    const prior = holdings.get(mint);
    holdings.set(mint, {
      mint,
      amountAtomic: String(BigInt(prior?.amountAtomic || '0') + quantity),
      decimals,
    });
  }
  return [...holdings.values()];
}

async function chainHoldings(connection, walletAddress) {
  let wallet;
  try { wallet = new PublicKey(walletAddress); } catch {
    throw Object.assign(new Error('Invalid wallet public key'), { status: 400 });
  }
  const results = await Promise.all(TOKEN_PROGRAMS.map((programId) =>
    connection.getParsedTokenAccountsByOwner(wallet, { programId }),
  ));
  const slots = results.map((result) => result?.context?.slot);
  if (slots.some((slot) => !Number.isSafeInteger(slot) || slot < 1)) {
    throw Object.assign(new Error('Token-account RPC returned no valid context slot'), { status: 503 });
  }
  const currentSlot = await connection.getSlot('confirmed');
  if (!Number.isSafeInteger(currentSlot) || currentSlot < 1 ||
      slots.some((slot) => currentSlot < slot || currentSlot - slot > MAX_STALE_SLOTS)) {
    throw Object.assign(new Error('Token-account data is stale or from a future slot'), { status: 503 });
  }
  return { holdings: results.flatMap(parseHoldings), slot: Math.min(...slots), currentSlot };
}

export async function getWalletMintBalance({ connection, walletAddress, mint }) {
  let wallet;
  let mintKey;
  try {
    wallet = new PublicKey(walletAddress);
    mintKey = new PublicKey(mint);
  } catch {
    throw Object.assign(new Error('Invalid wallet or mint public key'), { status: 400 });
  }
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet, { mint: mintKey });
  const slots = [accounts?.context?.slot];
  const currentSlot = await connection.getSlot('confirmed');
  if (slots.some((slot) => !Number.isSafeInteger(slot) || slot < 1 || currentSlot < slot || currentSlot - slot > MAX_STALE_SLOTS)) {
    throw Object.assign(new Error('Token balance data is stale or unavailable'), { status: 503 });
  }
  let amount = 0n;
  for (const account of accounts.value || []) {
    const raw = account.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
      throw Object.assign(new Error('Token balance data is malformed'), { status: 503 });
    }
    amount += BigInt(raw);
  }
  return { amountAtomic: String(amount), slot: Math.min(...slots), currentSlot };
}

async function portfolioSnapshot(connection, walletAddress, quote = getQuote) {
  const { holdings, slot } = await chainHoldings(connection, walletAddress);
  let exposureLamports = 0n;
  const valued = [];
  const quoteSlots = [];
  for (const holding of holdings) {
    const liquidation = await quote({
      inputMint: holding.mint,
      outputMint: SOL_MINT,
      amountAtomic: holding.amountAtomic,
      slippageBps: 100,
    });
    if (liquidation.inputMint !== holding.mint || liquidation.outputMint !== SOL_MINT ||
        liquidation.swapMode !== 'ExactIn' || liquidation.inAmount !== holding.amountAtomic ||
        typeof liquidation.otherAmountThreshold !== 'string' || !/^\d+$/.test(liquidation.otherAmountThreshold) ||
        !Number.isSafeInteger(liquidation.contextSlot) || liquidation.contextSlot < 1) {
      throw Object.assign(new Error(`Fresh liquidation quote unavailable for held mint ${holding.mint}`), { status: 503 });
    }
    quoteSlots.push(liquidation.contextSlot);
    const valueLamports = BigInt(liquidation.otherAmountThreshold);
    exposureLamports += valueLamports;
    valued.push({ ...holding, liquidationValueLamports: String(valueLamports) });
  }
  const latestSlot = await connection.getSlot('confirmed');
  if (!Number.isSafeInteger(latestSlot) || latestSlot < slot || latestSlot - slot > MAX_STALE_SLOTS ||
      quoteSlots.some((quoteSlot) => quoteSlot > latestSlot || latestSlot - quoteSlot > MAX_STALE_SLOTS)) {
    throw Object.assign(new Error('Token-account or liquidation quote data is stale'), { status: 503 });
  }
  return {
    walletAddress,
    asOf: new Date().toISOString(),
    chainSlot: slot,
    latestSlot,
    valuation: 'sum of fresh Jupiter ExactIn minimum-output SOL quotes for all positive SPL and Token-2022 balances',
    currentExposureLamports: String(exposureLamports),
    reservedExposureLamports: '0',
    totalExposureLamports: String(exposureLamports),
    openPositions: holdings.length,
    holdings: valued,
  };
}

function includeReservations(snapshot, reservations) {
  const active = reservations.filter((reservation) => reservation.walletAddress === snapshot.walletAddress);
  const reservedLamports = active.reduce((total, reservation) => total + BigInt(reservation.amountLamports), 0n);
  const openMints = new Set([...snapshot.holdings.map((holding) => holding.mint), ...active.map((reservation) => reservation.mint)]);
  return {
    ...snapshot,
    reservedExposureLamports: String(reservedLamports),
    totalExposureLamports: String(BigInt(snapshot.currentExposureLamports) + reservedLamports),
    openPositions: openMints.size,
  };
}

function sameReservationState(left, right) {
  return left.tradeId === right.tradeId && left.walletAddress === right.walletAddress &&
    left.mint === right.mint && left.amountLamports === right.amountLamports &&
    left.createdAt === right.createdAt &&
    (left.lastValidBlockHeight ?? null) === (right.lastValidBlockHeight ?? null) &&
    (left.signature ?? null) === (right.signature ?? null);
}

function pruneReconciledReservations(current, observed, reconciled) {
  const removable = observed.filter((reservation) =>
    !reconciled.some((remaining) => sameReservationState(reservation, remaining)),
  );
  return current.filter((reservation) =>
    !removable.some((candidate) => sameReservationState(reservation, candidate)),
  );
}

async function reconciledReservations(connection, walletAddress, chainSlot, reservations) {
  const ledger = { reservations: reservations.map((reservation) => ({ ...reservation })) };
  await reconcileReservations(connection, ledger, walletAddress, chainSlot);
  return ledger.reservations;
}

async function reconcileReservations(connection, ledger, walletAddress, chainSlot) {
  const height = await connection.getBlockHeight('confirmed');
  if (!Number.isSafeInteger(height) || height < 1) {
    throw Object.assign(new Error('Block-height RPC unavailable for reservation reconciliation'), { status: 503 });
  }
  const keep = [];
  for (const reservation of ledger.reservations) {
    if (reservation.walletAddress !== walletAddress) {
      keep.push(reservation);
      continue;
    }
    if (reservation.signature) {
      const status = (await connection.getSignatureStatuses([reservation.signature], {
        searchTransactionHistory: true,
      })).value?.[0];
      if (status?.err) continue;
      if (status?.confirmationStatus && ['confirmed', 'finalized'].includes(status.confirmationStatus) &&
          Number.isSafeInteger(status.slot) && chainSlot >= status.slot) continue;
      keep.push(reservation);
      continue;
    }
    if (Number.isSafeInteger(reservation.lastValidBlockHeight) && height > reservation.lastValidBlockHeight) continue;
    if (!reservation.signature && !Number.isSafeInteger(reservation.lastValidBlockHeight) &&
      Date.now() - reservation.createdAt > ABANDONED_BUILD_MS) continue;
    keep.push(reservation);
  }
  ledger.reservations = keep;
}

export async function reservePortfolioBuy({
  connection,
  walletAddress,
  mint,
  tradeId,
  amountLamports,
  maxPortfolioSol,
  maxOpenPositions,
}) {
  if (typeof tradeId !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(tradeId)) {
    throw Object.assign(new Error('Unique tradeId required for portfolio reservation'), { status: 400 });
  }
  const requested = BigInt(amountLamports);
  const chainSnapshot = await portfolioSnapshot(connection, walletAddress);
  const observed = await withLedgerLock((ledger) => ledger.reservations.map((reservation) => ({ ...reservation })));
  const reconciled = await reconciledReservations(connection, walletAddress, chainSnapshot.chainSlot, observed);
  return withLedgerLock(async (ledger) => {
    if (ledger.reservations.some((reservation) => reservation.tradeId === tradeId)) {
      throw Object.assign(new Error('Trade already has a portfolio reservation; reconcile before retrying'), { status: 409 });
    }
    ledger.reservations = pruneReconciledReservations(ledger.reservations, observed, reconciled);
    const snapshot = includeReservations(chainSnapshot, ledger.reservations);
    const cap = BigInt(Math.floor(maxPortfolioSol * 1_000_000_000));
    if (BigInt(snapshot.totalExposureLamports) + requested > cap) {
      throw Object.assign(new Error(`Portfolio cap exceeded: ${maxPortfolioSol} SOL`), { status: 400 });
    }
    const isExistingMint = snapshot.holdings.some((holding) => holding.mint === mint) ||
      ledger.reservations.some((reservation) => reservation.walletAddress === walletAddress && reservation.mint === mint);
    if (!isExistingMint && snapshot.openPositions >= maxOpenPositions) {
      throw Object.assign(new Error(`Open-position cap reached: ${maxOpenPositions}`), { status: 400 });
    }
    ledger.reservations.push({
      tradeId,
      walletAddress,
      mint,
      amountLamports: String(requested),
      createdAt: Date.now(),
    });
    return snapshot;
  });
}

export async function finishPortfolioReservation(tradeId, lastValidBlockHeight) {
  return withLedgerLock(async (ledger) => {
    const reservation = ledger.reservations.find((item) => item.tradeId === tradeId);
    if (reservation) reservation.lastValidBlockHeight = lastValidBlockHeight;
  });
}

export async function releasePortfolioReservation(tradeId) {
  return withLedgerLock(async (ledger) => {
    ledger.reservations = ledger.reservations.filter((item) => item.tradeId !== tradeId || item.signature);
  });
}

export async function markPortfolioReservationSubmitted(tradeId, signature) {
  return withLedgerLock(async (ledger) => {
    const reservation = ledger.reservations.find((item) => item.tradeId === tradeId);
    if (reservation) reservation.signature = signature;
  });
}

export async function getPortfolioSnapshot({ connection, walletAddress }) {
  const chainSnapshot = await portfolioSnapshot(connection, walletAddress);
  const observed = await withLedgerLock((ledger) => ledger.reservations.map((reservation) => ({ ...reservation })));
  const reconciled = await reconciledReservations(connection, walletAddress, chainSnapshot.chainSlot, observed);
  return withLedgerLock((ledger) => {
    ledger.reservations = pruneReconciledReservations(ledger.reservations, observed, reconciled);
    return includeReservations(chainSnapshot, ledger.reservations);
  });
}