import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * Account storage for the sign-in page: users with scrypt password hashes, and
 * server-side sessions. Plain passwords and raw session tokens are never stored.
 */

const scrypt = promisify(crypto.scrypt);

const DEFAULT_PATH = fileURLToPath(new URL('./.auth.sqlite', import.meta.url));

export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound so a huge password cannot make hashing slow. */
export const PASSWORD_MAX_LENGTH = 256;
const EMAIL_MAX_LENGTH = 254;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** scrypt cost settings (OWASP minimum is N=2^17 with r=8; 2^15 keeps sign-in fast on a small VPS). */
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SALT_LENGTH = 16;
/** scrypt needs 128 * N * r bytes; allow headroom above Node's 32 MiB default. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const SESSION_TOKEN_BYTES = 32;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

export function authStorePath() {
  return process.env.GMGN_AUTH_DB_PATH || DEFAULT_PATH;
}

/** Lower-case, trimmed email. Throws 400 when it is not a plausible address. */
export function normalizeEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, 'Enter a valid email address', 'INVALID_EMAIL');
  }
  return email;
}

/** Throws 400 when the password is too short or too long. */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw httpError(400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`, 'WEAK_PASSWORD');
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw httpError(400, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`, 'PASSWORD_TOO_LONG');
  }
}

async function deriveKey(password, salt, n, r, p) {
  return scrypt(password, salt, SCRYPT_KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

/** Returns "scrypt$N$r$p$salt$hash" (salt and hash base64url). */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Constant-time check of a password against a stored hash. Malformed hashes never match. */
export async function verifyPasswordHash(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isSafeInteger) || n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length !== SALT_LENGTH || expected.length !== SCRYPT_KEY_LENGTH) return false;
  const actual = await deriveKey(password, salt, n, r, p);
  return crypto.timingSafeEqual(actual, expected);
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
  `);
  return db;
}

/**
 * Opens (or creates) the account database.
 * @param {{ file?: string, now?: () => number }} [options]
 */
export function createAuthStore({ file = authStorePath(), now = Date.now } = {}) {
  const db = openDatabase(file);
  // Used when the email is unknown, so a miss costs the same time as a wrong password.
  const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

  const findUserByEmail = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?');
  const insertUser = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)');
  const insertSession = db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  );
  const findSession = db.prepare(`
    SELECT s.user_id, s.expires_at, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `);
  const removeSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const removeExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  return {
    /** Creates an email + password user. Throws 409 EMAIL_TAKEN if the email exists. */
    async createUser(rawEmail, password) {
      const email = normalizeEmail(rawEmail);
      validatePassword(password);
      const passwordHash = await hashPassword(password);
      try {
        const result = insertUser.run(email, passwordHash, now());
        return { id: Number(result.lastInsertRowid), email };
      } catch (error) {
        if (error?.errcode === 2067 || /UNIQUE constraint failed/.test(String(error?.message))) {
          throw httpError(409, 'An account with this email already exists', 'EMAIL_TAKEN');
        }
        throw error;
      }
    },

    /** Returns { id, email } when the email and password match, otherwise null. */
    async checkPassword(rawEmail, password) {
      let email;
      try {
        email = normalizeEmail(rawEmail);
      } catch {
        email = null;
      }
      const user = email ? findUserByEmail.get(email) : undefined;
      if (typeof password !== 'string' || password.length > PASSWORD_MAX_LENGTH) return null;
      const ok = await verifyPasswordHash(password, user?.password_hash ?? (await dummyHash));
      return ok && user?.password_hash ? { id: Number(user.id), email: user.email } : null;
    },

    /** Starts a session. Returns the raw token for the cookie; only its hash is stored. */
    createSession(userId) {
      const t = now();
      removeExpiredSessions.run(t);
      const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
      const expiresAt = t + SESSION_TTL_MS;
      insertSession.run(hashSessionToken(token), userId, t, expiresAt);
      return { token, expiresAt };
    },

    /** Returns { userId, email, expiresAt } for a live session, otherwise null. */
    getSession(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 128) return null;
      const tokenHash = hashSessionToken(token);
      const row = findSession.get(tokenHash);
      if (!row) return null;
      if (row.expires_at <= now()) {
        removeSession.run(tokenHash);
        return null;
      }
      return { userId: Number(row.user_id), email: row.email, expiresAt: Number(row.expires_at) };
    },

    /** Ends a session. Unknown tokens are ignored. */
    deleteSession(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 128) return;
      removeSession.run(hashSessionToken(token));
    },

    close() {
      db.close();
    },
  };
}
