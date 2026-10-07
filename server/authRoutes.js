import { createAuthStore, normalizeEmail, SESSION_TTL_MS } from './authStore.js';

/**
 * Sign-up / sign-in / sign-out routes, and the middleware that requires a
 * signed-in session on every other /api route.
 */

export const SESSION_COOKIE = 'gmgn_session';
const AUTH_PREFIX = '/api/auth/';

/** Failed attempts allowed per email (and per IP) inside the window before a lockout. */
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 20;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
/** Bound on remembered keys so a flood of distinct emails/IPs cannot grow memory without limit. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * Parses GMGN_ALLOWED_EMAILS (comma-separated) into a Set of normalized emails.
 * An empty or missing value means nobody may sign up or sign in.
 */
export function parseAllowedEmails(raw) {
  const allowed = new Set();
  for (const part of String(raw ?? '').split(',')) {
    if (part.trim() === '') continue;
    try {
      allowed.add(normalizeEmail(part));
    } catch {
      throw new Error('Invalid configuration: GMGN_ALLOWED_EMAILS has an entry that is not an email address');
    }
  }
  return allowed;
}

/** Counts failures per key within a sliding window. In-memory: resets when the server restarts. */
export function createAttemptLimiter({ maxFailures, windowMs, now = Date.now }) {
  const failures = new Map();

  function recent(key) {
    const cutoff = now() - windowMs;
    const list = (failures.get(key) || []).filter((t) => t > cutoff);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  }

  return {
    /** Milliseconds until the key may try again, or 0 when it is not locked. */
    retryAfterMs(key) {
      const list = recent(key);
      return list.length >= maxFailures ? list[0] + windowMs - now() : 0;
    },
    recordFailure(key) {
      if (!failures.has(key) && failures.size >= MAX_TRACKED_KEYS) {
        for (const k of [...failures.keys()]) recent(k);
        if (failures.size >= MAX_TRACKED_KEYS) failures.delete(failures.keys().next().value);
      }
      failures.set(key, [...recent(key), now()]);
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

/**
 * @param {import('express').Express} app
 * @param {{
 *   openStore?: () => ReturnType<typeof createAuthStore>,
 *   allowedEmails?: () => Set<string>,
 *   secureCookies?: () => boolean,
 *   now?: () => number,
 * }} [options]
 * @returns {import('express').RequestHandler} middleware requiring a signed-in session
 */
export function registerAuthRoutes(app, {
  openStore = createAuthStore,
  allowedEmails = () => parseAllowedEmails(process.env.GMGN_ALLOWED_EMAILS),
  secureCookies = () => process.env.NODE_ENV === 'production',
  now = Date.now,
} = {}) {
  let store;
  const getStore = () => (store ??= openStore());
  const emailLimiter = createAttemptLimiter({ maxFailures: MAX_FAILURES_PER_EMAIL, windowMs: LOCKOUT_WINDOW_MS, now });
  const ipLimiter = createAttemptLimiter({ maxFailures: MAX_FAILURES_PER_IP, windowMs: LOCKOUT_WINDOW_MS, now });

  function setSessionCookie(res, token) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies(),
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
  }

  function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secureCookies(), path: '/' });
  }

  /** Locked-out callers get 429 before any password work is done. */
  function lockedOut(res, keys) {
    const waitMs = Math.max(...keys.map(([limiter, key]) => limiter.retryAfterMs(key)));
    if (waitMs <= 0) return false;
    res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
    res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
    return true;
  }

  /** State-changing auth routes accept JSON only, which browsers cannot send cross-site without CORS approval. */
  function requireJson(req, res, next) {
    if (!req.is('application/json')) {
      return res.status(415).json({ ok: false, error: 'Send JSON (Content-Type: application/json)' });
    }
    next();
  }

  function startSession(res, user, status) {
    const { token } = getStore().createSession(user.id);
    setSessionCookie(res, token);
    res.status(status).json({ ok: true, user: { email: user.email } });
  }

  app.post('/api/auth/signup', requireJson, async (req, res) => {
    const ipKey = `ip:${req.ip}`;
    if (lockedOut(res, [[ipLimiter, ipKey]])) return;
    try {
      const email = normalizeEmail(req.body?.email);
      if (!allowedEmails().has(email)) {
        ipLimiter.recordFailure(ipKey);
        return res.status(403).json({ ok: false, error: 'Sign-up is closed for this email address' });
      }
      const user = await getStore().createUser(email, req.body?.password);
      startSession(res, user, 201);
    } catch (e) {
      if (e.status === 409) ipLimiter.recordFailure(ipKey);
      if (e.status) return res.status(e.status).json({ ok: false, error: e.message });
      console.error('Sign-up failed:', e.message);
      res.status(500).json({ ok: false, error: 'Sign-up failed' });
    }
  });

  app.post('/api/auth/signin', requireJson, async (req, res) => {
    const ipKey = `ip:${req.ip}`;
    const emailKey = `email:${String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254)}`;
    if (lockedOut(res, [[ipLimiter, ipKey], [emailLimiter, emailKey]])) return;
    try {
      const user = await getStore().checkPassword(req.body?.email, req.body?.password);
      // The allow-list is checked after the password so both failures take the same time and look the same.
      if (!user || !allowedEmails().has(user.email)) {
        ipLimiter.recordFailure(ipKey);
        emailLimiter.recordFailure(emailKey);
        return res.status(401).json({ ok: false, error: 'Email or password is incorrect' });
      }
      emailLimiter.reset(emailKey);
      startSession(res, user, 200);
    } catch (e) {
      console.error('Sign-in failed:', e.message);
      res.status(500).json({ ok: false, error: 'Sign-in failed' });
    }
  });

  app.post('/api/auth/signout', requireJson, (req, res) => {
    try {
      getStore().deleteSession(readCookie(req, SESSION_COOKIE));
    } catch (e) {
      console.error('Sign-out failed:', e.message);
      return res.status(500).json({ ok: false, error: 'Sign-out failed' });
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  /** Resolves the request's session, or null. Sessions for emails removed from the allow-list are ended. */
  function currentUser(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const session = getStore().getSession(token);
    if (!session) return null;
    if (!allowedEmails().has(session.email)) {
      getStore().deleteSession(token);
      return null;
    }
    return session;
  }

  app.get('/api/auth/me', (req, res) => {
    try {
      const session = currentUser(req);
      if (!session) return res.status(401).json({ ok: false, error: 'Not signed in' });
      res.json({ ok: true, user: { email: session.email } });
    } catch (e) {
      console.error('Session check failed:', e.message);
      res.status(500).json({ ok: false, error: 'Session check failed' });
    }
  });

  return function requireSignIn(req, res, next) {
    if (req.originalUrl.startsWith(AUTH_PREFIX)) return next();
    try {
      const session = currentUser(req);
      if (!session) return res.status(401).json({ ok: false, error: 'Sign in required' });
      req.user = { id: session.userId, email: session.email };
      next();
    } catch (e) {
      console.error('Session check failed:', e.message);
      res.status(500).json({ ok: false, error: 'Session check failed' });
    }
  };
}
