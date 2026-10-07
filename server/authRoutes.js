import crypto from 'node:crypto';
import express from 'express';
import { createAuthStore, normalizeEmail, SESSION_TTL_MS } from './authStore.js';
import { appleSettings, createAppleProvider, createOidcProvider, googleSettings } from './externalSignIn.js';

/**
 * Sign-up / sign-in / sign-out routes, and the middleware that requires a
 * signed-in session on every other /api route.
 */

export const SESSION_COOKIE = 'gmgn_session';
/** Holds the id of a Google/Apple sign-in in progress, between leaving the app and coming back. */
export const OAUTH_COOKIE = 'gmgn_oauth';
export const EXTERNAL_PROVIDERS = ['google', 'apple'];
const PROVIDER_LABELS = { google: 'Google', apple: 'Apple' };
const OAUTH_PENDING_MS = 10 * 60 * 1000;
const MAX_PENDING_OAUTH = 1_000;
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
 *   signupOpen?: () => boolean,
 *   secureCookies?: () => boolean,
 *   now?: () => number,
 *   externalProviders?: Record<'google' | 'apple', () => ReturnType<typeof createOidcProvider> | null>,
 * }} [options]
 * @returns {import('express').RequestHandler} middleware requiring a signed-in session
 */
export function registerAuthRoutes(app, {
  openStore = createAuthStore,
  allowedEmails = () => parseAllowedEmails(process.env.GMGN_ALLOWED_EMAILS),
  // Off unless GMGN_SIGNUP_OPEN=1, so nobody can claim an allow-listed email before its owner does.
  signupOpen = () => process.env.GMGN_SIGNUP_OPEN === '1',
  secureCookies = () => process.env.NODE_ENV === 'production',
  now = Date.now,
  externalProviders = {
    google: () => {
      const settings = googleSettings();
      return settings ? createOidcProvider(settings) : null;
    },
    apple: () => {
      const settings = appleSettings();
      return settings ? createAppleProvider(settings) : null;
    },
  },
} = {}) {
  let store;
  const getStore = () => (store ??= openStore());
  /** Each provider is built once, on first use; null when it is not set up. */
  const providerCache = new Map();
  const getProvider = (name) => {
    if (!providerCache.has(name)) providerCache.set(name, externalProviders[name]?.() ?? null);
    return providerCache.get(name);
  };
  /** Google/Apple sign-ins in progress, by the random id in the OAUTH_COOKIE. One process only. */
  const pendingOAuth = new Map();
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
    if (!signupOpen()) {
      return res.status(403).json({
        ok: false,
        error: 'Sign-up is closed. The server owner can open it with GMGN_SIGNUP_OPEN=1.',
        code: 'SIGNUP_CLOSED',
      });
    }
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

  /** Whether a provider is set up. A broken setup is logged and reported as not set up. */
  function providerReady(name) {
    try {
      return Boolean(getProvider(name));
    } catch (e) {
      console.error(`${PROVIDER_LABELS[name]} sign-in settings are invalid:`, e.message);
      return false;
    }
  }

  app.get('/api/auth/providers', (_req, res) => {
    res.json({ ok: true, google: providerReady('google'), apple: providerReady('apple') });
  });

  function prunePendingOAuth() {
    const t = now();
    for (const [id, entry] of pendingOAuth) if (entry.expiresAt <= t) pendingOAuth.delete(id);
    while (pendingOAuth.size >= MAX_PENDING_OAUTH) pendingOAuth.delete(pendingOAuth.keys().next().value);
  }

  /**
   * Apple returns with a cross-site form POST, which browsers only send cookies with when
   * they are SameSite=None (and so Secure). Google returns with a normal link (Lax is enough).
   */
  function oauthCookieOptions(name, provider) {
    const formPost = provider?.responseMode === 'form_post';
    return {
      httpOnly: true,
      sameSite: formPost ? 'none' : 'lax',
      secure: formPost || secureCookies(),
      path: `/api/auth/${name}`,
    };
  }

  /** Sends the browser back to the starting page with a short reason code it can explain. */
  function failExternalSignIn(res, name, provider, reason) {
    res.clearCookie(OAUTH_COOKIE, oauthCookieOptions(name, provider));
    res.redirect(303, `/?signin_error=${encodeURIComponent(reason)}&signin_provider=${name}`);
  }

  for (const name of EXTERNAL_PROVIDERS) {
    const label = PROVIDER_LABELS[name];

    app.get(`/api/auth/${name}/start`, async (_req, res) => {
      if (!providerReady(name)) return failExternalSignIn(res, name, null, 'not_configured');
      const provider = getProvider(name);
      try {
        const { url, pending } = await provider.start();
        prunePendingOAuth();
        const id = crypto.randomBytes(32).toString('base64url');
        pendingOAuth.set(id, { ...pending, provider: name, expiresAt: now() + OAUTH_PENDING_MS });
        res.cookie(OAUTH_COOKIE, id, { ...oauthCookieOptions(name, provider), maxAge: OAUTH_PENDING_MS });
        res.redirect(303, url);
      } catch (e) {
        console.error(`${label} sign-in could not start:`, e.message);
        failExternalSignIn(res, name, provider, 'failed');
      }
    });

    const callback = async (req, res) => {
      const provider = providerReady(name) ? getProvider(name) : null;
      const id = readCookie(req, OAUTH_COOKIE);
      const pending = id ? pendingOAuth.get(id) : undefined;
      if (id) pendingOAuth.delete(id); // one use only
      const formPost = provider?.responseMode === 'form_post';
      const response = formPost
        ? { form: new URLSearchParams(Object.entries(req.body ?? {}).filter(([, v]) => typeof v === 'string')) }
        : { search: new URL(req.originalUrl, 'http://placeholder').search };
      const errorParam = formPost ? response.form.get('error') : req.query.error;
      if (!provider) return failExternalSignIn(res, name, provider, 'not_configured');
      if (typeof errorParam === 'string' && errorParam) return failExternalSignIn(res, name, provider, 'cancelled');
      if (!pending || pending.provider !== name || pending.expiresAt <= now()) {
        return failExternalSignIn(res, name, provider, 'expired');
      }
      try {
        const account = await provider.finish(response, pending);
        if (!account.subject || !account.email || !account.emailVerified) {
          return failExternalSignIn(res, name, provider, 'unverified');
        }
        const email = normalizeEmail(account.email);
        if (!allowedEmails().has(email)) return failExternalSignIn(res, name, provider, 'not_allowed');
        const user = getStore().findOrCreateExternalUser(name, account.subject, email);
        const { token } = getStore().createSession(user.id);
        res.clearCookie(OAUTH_COOKIE, oauthCookieOptions(name, provider));
        setSessionCookie(res, token);
        res.redirect(303, '/');
      } catch (e) {
        console.error(`${label} sign-in failed:`, e.message);
        failExternalSignIn(res, name, provider, 'failed');
      }
    };
    app.get(`/api/auth/${name}/callback`, callback);
    app.post(`/api/auth/${name}/callback`, express.urlencoded({ extended: false, limit: '16kb' }), callback);
  }

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
      if (!session) return res.status(401).json({ ok: false, error: 'Sign in required', code: 'SIGN_IN_REQUIRED' });
      req.user = { id: session.userId, email: session.email };
      next();
    } catch (e) {
      console.error('Session check failed:', e.message);
      res.status(500).json({ ok: false, error: 'Session check failed' });
    }
  };
}
