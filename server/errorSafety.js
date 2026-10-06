/**
 * Keeps secrets out of what the browser receives. Upstream errors (RPC, Jupiter, the GMGN CLI) can
 * quote the URL or key they used, and Helius/QuickNode RPC URLs carry the API key in the URL, so
 * every JSON response is scrubbed before it is sent.
 */

/** Environment values that must never appear in a response. */
const SECRET_ENV_KEYS = ['SOLANA_RPC_URL', 'VITE_SOLANA_RPC_URL', 'GMGN_API_KEY', 'GMGN_LOCAL_TOKEN'];

/** Shorter values are too likely to match ordinary text to be replaced safely. */
const MIN_SECRET_LENGTH = 8;

/** Fields that carry error or diagnostic text; URLs in them are cut down to their origin. */
const DIAGNOSTIC_KEYS = new Set([
  'error', 'message', 'details', 'blockers', 'warnings', 'reason',
  'lastError', 'workerError', 'schedulerError', 'marketError', 'stdout', 'stderr',
]);

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

export const REDACTED = '[redacted]';

export function secretValues(env = process.env) {
  return SECRET_ENV_KEYS
    .map(k => String(env[k] ?? '').trim())
    .filter(v => v.length >= MIN_SECRET_LENGTH);
}

/** Keeps only scheme and host, dropping user info, path and query where keys usually sit. */
function urlOrigin(raw) {
  try {
    return new URL(raw).origin;
  } catch {
    return REDACTED;
  }
}

export function redactText(text, secrets, { diagnostic = false } = {}) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  if (diagnostic) out = out.replace(URL_PATTERN, urlOrigin);
  return out;
}

/** Returns a copy of a JSON body with secrets replaced everywhere and URLs shortened in diagnostic fields. */
export function sanitizeBody(value, secrets, diagnostic = false) {
  if (typeof value === 'string') return redactText(value, secrets, { diagnostic });
  if (Array.isArray(value)) return value.map(v => sanitizeBody(v, secrets, diagnostic));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value)
      .map(([k, v]) => [k, sanitizeBody(v, secrets, diagnostic || DIAGNOSTIC_KEYS.has(k))]));
  }
  return value;
}

/** Wraps res.json so every JSON response from this app is scrubbed. */
export function safeJsonResponses({ env = process.env } = {}) {
  return function scrubJson(_req, res, next) {
    const send = res.json.bind(res);
    res.json = body => send(sanitizeBody(body, secretValues(env)));
    next();
  };
}

/**
 * Last-resort handler for errors no route caught. Client errors (4xx, such as malformed JSON)
 * keep their message; anything else is logged on the server and answered with a generic message.
 */
export function jsonErrorHandler({ env = process.env, log = console.error } = {}) {
  // Express recognizes error handlers by their four parameters, so _next must stay.
  return function handleError(err, _req, res, _next) {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) {
      log(`Unhandled server error: ${redactText(err?.stack || err, secretValues(env), { diagnostic: true })}`);
    }
    if (res.headersSent) return;
    const error = status < 500 && err?.expose !== false ? String(err?.message || 'Bad request') : 'Internal server error';
    res.status(status).json({ ok: false, error });
  };
}
