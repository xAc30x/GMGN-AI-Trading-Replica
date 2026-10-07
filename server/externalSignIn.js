import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as oidc from 'openid-client';

/**
 * Sign-in through an OpenID Connect provider (Google or Apple), using the
 * authorization-code flow with PKCE, state and nonce. openid-client checks the
 * ID token's signature, issuer, audience, expiry and nonce.
 */

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const APPLE_ISSUER = 'https://appleid.apple.com';
/**
 * Apple's published endpoints (from https://appleid.apple.com/.well-known/openid-configuration),
 * written out so Apple sign-in does not depend on an extra discovery request.
 */
export const APPLE_SERVER_METADATA = Object.freeze({
  issuer: APPLE_ISSUER,
  authorization_endpoint: 'https://appleid.apple.com/auth/authorize',
  token_endpoint: 'https://appleid.apple.com/auth/token',
  jwks_uri: 'https://appleid.apple.com/auth/keys',
  response_modes_supported: ['query', 'fragment', 'form_post'],
  id_token_signing_alg_values_supported: ['RS256'],
  token_endpoint_auth_methods_supported: ['client_secret_post'],
});
/** Apple's client secret is a short-lived signed token, made fresh for each sign-in. */
const APPLE_SECRET_TTL_SECONDS = 300;
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
  return { issuer: GOOGLE_ISSUER, clientId, clientSecret, redirectUri, authorizationParams: { prompt: 'select_account' } };
}

/**
 * Reads the Apple settings. Returns null when Apple sign-in is not set up; throws when
 * it is only partly set up or the key file is unusable. Apple only accepts https addresses.
 */
export function appleSettings(env = process.env, home = os.homedir()) {
  const names = ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY_PATH'];
  const values = Object.fromEntries(names.map((n) => [n, (env[n] ?? '').trim()]));
  const missing = names.filter((n) => !values[n]);
  if (missing.length === names.length) return null;
  if (missing.length) {
    throw new Error(`Invalid configuration: Apple sign-in also needs ${missing.join(', ')} (set all four, or none)`);
  }
  if (!(env.GMGN_PUBLIC_URL ?? '').trim()) {
    throw new Error('Invalid configuration: Apple sign-in needs GMGN_PUBLIC_URL');
  }
  const publicUrl = parsePublicUrl(env.GMGN_PUBLIC_URL);
  if (publicUrl.protocol !== 'https:') {
    throw new Error('Invalid configuration: Apple sign-in only works on an https:// GMGN_PUBLIC_URL, not localhost');
  }
  const rawPath = values.APPLE_PRIVATE_KEY_PATH;
  const keyPath = rawPath.startsWith('~/') ? path.join(home, rawPath.slice(2)) : rawPath;
  if (!path.isAbsolute(keyPath)) {
    throw new Error('Invalid configuration: APPLE_PRIVATE_KEY_PATH must be absolute or start with ~/');
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  } catch (error) {
    // Names the path and the reason only; never the file's contents.
    throw new Error(`Invalid configuration: cannot read the Apple key at ${keyPath} (${error.code || 'not a private key'})`);
  }
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`Invalid configuration: ${keyPath} is not an Apple sign-in key (.p8, P-256)`);
  }
  return {
    issuer: APPLE_ISSUER,
    clientId: values.APPLE_CLIENT_ID,
    teamId: values.APPLE_TEAM_ID,
    keyId: values.APPLE_KEY_ID,
    privateKey,
    redirectUri: new URL('/api/auth/apple/callback', publicUrl).href,
  };
}

/** The ES256-signed token Apple accepts in place of a fixed client secret. */
export function createAppleClientSecret({ teamId, keyId, clientId, privateKey, audience = APPLE_ISSUER, now = Date.now }) {
  const iat = Math.floor(now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode({ alg: 'ES256', kid: keyId })}.${encode({
    iss: teamId,
    iat,
    exp: iat + APPLE_SECRET_TTL_SECONDS,
    aud: audience,
    sub: clientId,
  })}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * Apple sign-in: returns with a form POST, and authenticates with a fresh signed client secret.
 * @param {ReturnType<typeof appleSettings>} settings
 * @param {{ serverMetadata?: object, allowHttp?: boolean }} [testing] only for tests against a local fake provider
 */
export function createAppleProvider(settings, { serverMetadata = APPLE_SERVER_METADATA, allowHttp = false } = {}) {
  const { issuer, clientId, teamId, keyId, privateKey, redirectUri } = settings;
  return createOidcProvider({
    issuer,
    clientId,
    redirectUri,
    serverMetadata,
    responseMode: 'form_post',
    allowHttp,
    clientAuthentication: (_as, _client, body) => {
      body.set('client_id', clientId);
      body.set('client_secret', createAppleClientSecret({ teamId, keyId, clientId, privateKey, audience: issuer }));
    },
  });
}

/**
 * @param {{
 *   issuer: string,
 *   clientId: string,
 *   redirectUri: string,
 *   clientSecret?: string,
 *   clientAuthentication?: import('openid-client').ClientAuth,
 *   serverMetadata?: import('openid-client').ServerMetadata,
 *   responseMode?: 'query' | 'form_post',
 *   authorizationParams?: Record<string, string>,
 *   allowHttp?: boolean,
 * }} settings
 *   clientAuthentication replaces clientSecret when the secret must be made per request (Apple).
 *   serverMetadata skips the discovery request. allowHttp is only for tests against a local fake provider.
 */
export function createOidcProvider({
  issuer,
  clientId,
  redirectUri,
  clientSecret,
  clientAuthentication,
  serverMetadata,
  responseMode = 'query',
  authorizationParams = {},
  allowHttp = false,
}) {
  const auth = clientAuthentication ?? oidc.ClientSecretPost(clientSecret);
  let configuration;
  const getConfiguration = () => {
    if (serverMetadata) {
      if (!configuration) {
        const config = new oidc.Configuration(serverMetadata, clientId, undefined, auth);
        if (allowHttp) oidc.allowInsecureRequests(config);
        configuration = Promise.resolve(config);
      }
      return configuration;
    }
    configuration ??= oidc
      .discovery(new URL(issuer), clientId, undefined, auth, allowHttp ? { execute: [oidc.allowInsecureRequests] } : undefined)
      .catch((error) => {
        configuration = undefined; // retry discovery on the next attempt
        throw error;
      });
    return configuration;
  };

  return {
    /** How the provider returns to redirectUri: 'query' is a GET, 'form_post' is a POST with a form body. */
    responseMode,

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
        ...(responseMode === 'form_post' ? { response_mode: 'form_post' } : {}),
        ...authorizationParams,
      });
      return { url: url.href, pending: { verifier, state, nonce } };
    },

    /**
     * Exchanges the callback's code for a checked ID token.
     * @param {{ search?: string, form?: URLSearchParams }} response what the provider sent back
     *   to the redirect URI: the query string (GET) or the form body (form_post).
     */
    async finish(response, pending) {
      const config = await getConfiguration();
      const callback = responseMode === 'form_post'
        ? new Request(redirectUri, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: (response.form ?? new URLSearchParams()).toString(),
          })
        : Object.assign(new URL(redirectUri), { search: response.search ?? '' });
      const tokens = await oidc.authorizationCodeGrant(config, callback, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      return {
        subject: String(claims?.sub ?? ''),
        email: typeof claims?.email === 'string' ? claims.email : '',
        // Apple sends "true" as a string; Google sends a boolean.
        emailVerified: claims?.email_verified === true || claims?.email_verified === 'true',
      };
    },
  };
}
