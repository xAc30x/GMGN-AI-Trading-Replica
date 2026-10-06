/**
 * Security headers for every response. The page asks a wallet to sign transactions, so the
 * Content-Security-Policy only allows scripts from this server and blocks framing by other sites.
 * HSTS is left to the HTTPS reverse proxy, because this process only speaks plain HTTP on loopback.
 */

/** Origins the wallet adapters and fonts need. Solflare's SDK connects through an iframe. */
const FONT_STYLE_ORIGIN = 'https://fonts.googleapis.com';
const FONT_FILE_ORIGIN = 'https://fonts.gstatic.com';
const SOLFLARE_FRAME_ORIGIN = 'https://connect.solflare.com';

/**
 * Extra connect-src entries for a browser RPC set at build time (VITE_SOLANA_RPC_URL).
 * Returns [] when unset or not an http(s) URL; the default browser RPC is this server's proxy.
 */
export function browserRpcOrigins(rawUrl) {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return [];
  let url;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return [url.origin, `${wsProtocol}//${url.host}`];
}

export function contentSecurityPolicy({ browserRpcUrl } = {}) {
  const connectSrc = ["'self'", ...browserRpcOrigins(browserRpcUrl)];
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Wallet modal and React inline styles; scripts stay strict.
    `style-src 'self' 'unsafe-inline' ${FONT_STYLE_ORIGIN}`,
    `font-src 'self' ${FONT_FILE_ORIGIN}`,
    "img-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    `frame-src ${SOLFLARE_FRAME_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders({ browserRpcUrl } = {}) {
  const csp = contentSecurityPolicy({ browserRpcUrl });
  return function setSecurityHeaders(_req, res, next) {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    });
    next();
  };
}
