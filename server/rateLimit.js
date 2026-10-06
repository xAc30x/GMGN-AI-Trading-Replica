/**
 * In-memory fixed-window counters keyed by client address. One backend process serves the app
 * (see README), so memory is the shared store; counts reset when the process restarts.
 */

/** Expired entries are swept once the map grows past this, so unique addresses cannot grow it forever. */
const SWEEP_THRESHOLD = 10_000;

export function createWindowCounter({ windowMs, max, now = Date.now }) {
  if (!Number.isInteger(max) || max < 1) throw new Error('Invalid rate limit: max must be a positive integer');
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('Invalid rate limit: windowMs must be positive');
  const entries = new Map();

  function current(key) {
    const t = now();
    const entry = entries.get(key);
    if (entry && entry.resetAt > t) return entry;
    if (entries.size >= SWEEP_THRESHOLD) {
      for (const [k, e] of entries) if (e.resetAt <= t) entries.delete(k);
    }
    const fresh = { count: 0, resetAt: t + windowMs };
    entries.set(key, fresh);
    return fresh;
  }

  function retryAfterSeconds(entry) {
    return Math.max(1, Math.ceil((entry.resetAt - now()) / 1000));
  }

  return {
    /** Count one event; returns whether it stayed within the limit. */
    hit(key) {
      const entry = current(key);
      entry.count += 1;
      return { allowed: entry.count <= max, retryAfterSeconds: retryAfterSeconds(entry) };
    },
    /** Whether the key has already used up its window, without counting anything. */
    blocked(key) {
      const entry = current(key);
      return { blocked: entry.count >= max, retryAfterSeconds: retryAfterSeconds(entry) };
    },
    size: () => entries.size,
  };
}

function tooMany(res, retryAfterSeconds, error) {
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({ ok: false, error });
}

/** Caps requests per client address per minute. */
export function requestRateLimit({ perMinute, now }) {
  const counter = createWindowCounter({ windowMs: 60_000, max: perMinute, now });
  return function limitRequests(req, res, next) {
    const { allowed, retryAfterSeconds } = counter.hit(req.ip);
    if (!allowed) return tooMany(res, retryAfterSeconds, 'Too many requests. Try again shortly.');
    next();
  };
}

/**
 * Tracks wrong-token attempts per client address. Once an address reaches the limit, every token
 * attempt from it is refused until the window ends, including a correct one, so guessing stops.
 */
export function authFailureGuard({ maxFailures, windowMs, now }) {
  const counter = createWindowCounter({ windowMs, max: maxFailures, now });
  return {
    rejectIfLocked(req, res) {
      const { blocked, retryAfterSeconds } = counter.blocked(req.ip);
      if (!blocked) return false;
      tooMany(res, retryAfterSeconds, 'Too many wrong token attempts. Try again later.');
      return true;
    },
    recordFailure(req) {
      counter.hit(req.ip);
    },
  };
}
