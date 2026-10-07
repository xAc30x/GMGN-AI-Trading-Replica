import * as oidc from 'openid-client';

/**
 * Sign-in through an OpenID Connect provider (Google today), using the
 * authorization-code flow with PKCE, state and nonce. openid-client checks the
 * ID token's signature, issuer, audience, expiry and nonce.
 */

export const GOOGLE_ISSUER = 'https://accounts.google.com';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validates GMGN_PUBLIC_URL: the address people type to open the app.
 * HTTPS is required except on this computer (localhost).
 */
export function parsePublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('Invalid configuration: GMGN_PUBLIC_URL must be a full address such as https://trader.example.com');
  }
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Invalid configuration: GMGN_PUBLIC_URL must use https:// (http:// only for localhost)');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Invalid configuration: GMGN_PUBLIC_URL must be only scheme, host and optional port');
  }
  return url;
}

/**
 * Reads the Google settings. Returns null when Google sign-in is not set up;
 * throws when it is only partly set up, so a typo is not silently ignored.
 */
export function googleSettings(env = process.env) {
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error('Invalid configuration: set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither');
  }
  if (!(env.GMGN_PUBLIC_URL ?? '').trim()) {
    throw new Error('Invalid configuration: Google sign-in needs GMGN_PUBLIC_URL');
  }
  const redirectUri = new URL('/api/auth/google/callback', parsePublicUrl(env.GMGN_PUBLIC_URL)).href;
  return { issuer: GOOGLE_ISSUER, clientId, clientSecret, redirectUri };
}

/**
 * @param {{ issuer: string, clientId: string, clientSecret: string, redirectUri: string, allowHttp?: boolean }} settings
 *   allowHttp is only for tests against a local fake provider.
 */
export function createOidcProvider({ issuer, clientId, clientSecret, redirectUri, allowHttp = false }) {
  let configuration;
  const getConfiguration = () => {
    configuration ??= oidc
      .discovery(new URL(issuer), clientId, clientSecret, undefined, allowHttp ? { execute: [oidc.allowInsecureRequests] } : undefined)
      .catch((error) => {
        configuration = undefined; // retry discovery on the next attempt
        throw error;
      });
    return configuration;
  };

  return {
    /** Returns the provider URL to send the browser to, and the one-time values to keep until the callback. */
    async start() {
      const config = await getConfiguration();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid email',
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        prompt: 'select_account',
      });
      return { url: url.href, pending: { verifier, state, nonce } };
    },

    /**
     * Exchanges the callback's code for a checked ID token.
     * @param {string} search the query string the provider sent back to the redirect URI
     */
    async finish(search, pending) {
      const config = await getConfiguration();
      const callbackUrl = new URL(redirectUri);
      callbackUrl.search = search;
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      return {
        subject: String(claims?.sub ?? ''),
        email: typeof claims?.email === 'string' ? claims.email : '',
        emailVerified: claims?.email_verified === true,
      };
    },
  };
}
