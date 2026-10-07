import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appleSettings,
  createAppleClientSecret,
  createAppleProvider,
  createOidcProvider,
  googleSettings,
  parsePublicUrl,
} from '../externalSignIn.js';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'http://localhost:5173/api/auth/google/callback';

test('parsePublicUrl accepts https anywhere and http only on this computer', () => {
  assert.equal(parsePublicUrl('https://trader.example.com').origin, 'https://trader.example.com');
  assert.equal(parsePublicUrl('http://localhost:5173/').origin, 'http://localhost:5173');
  assert.equal(parsePublicUrl('http://127.0.0.1:8787').origin, 'http://127.0.0.1:8787');
  for (const bad of ['', 'trader.example.com', 'http://trader.example.com', 'https://x.com/app', 'https://x.com/?a=1', 'ftp://localhost']) {
    assert.throws(() => parsePublicUrl(bad), /GMGN_PUBLIC_URL/, bad);
  }
});

test('googleSettings is off when unset and refuses half a setup', () => {
  assert.equal(googleSettings({}), null);
  assert.throws(() => googleSettings({ GOOGLE_CLIENT_ID: 'id' }), /both/);
  assert.throws(() => googleSettings({ GOOGLE_CLIENT_SECRET: 'secret' }), /both/);
  assert.throws(() => googleSettings({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }), /GMGN_PUBLIC_URL/);
  assert.deepEqual(
    googleSettings({ GOOGLE_CLIENT_ID: ' id ', GOOGLE_CLIENT_SECRET: 'secret', GMGN_PUBLIC_URL: 'https://trader.example.com' }),
    { issuer: 'https://accounts.google.com', clientId: 'id', clientSecret: 'secret',
      redirectUri: 'https://trader.example.com/api/auth/google/callback', authorizationParams: { prompt: 'select_account' } },
  );
});

function base64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

function signJwt(claims, privateKey, kid) {
  const head = base64url({ alg: 'RS256', typ: 'JWT', kid });
  const body = base64url(claims);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

/**
 * A minimal OpenID Connect provider on 127.0.0.1. It checks the client secret and
 * the PKCE verifier, and signs ID tokens with its own key, like Google does.
 */
async function startFakeProvider(t, tweak = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key';
  const codes = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') {
      return send(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      // openid-client sends the secret in the form body (client_secret_post).
      const clientOk = tweak.checkClient
        ? tweak.checkClient(form, issuer)
        : form.get('client_id') === CLIENT_ID && form.get('client_secret') === CLIENT_SECRET;
      if (!clientOk) return send(401, { error: 'invalid_client' });
      const grant = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (!grant || grant.challenge !== challenge || form.get('redirect_uri') !== (tweak.redirectUri ?? REDIRECT_URI)) {
        return send(400, { error: 'invalid_grant' });
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuer, aud: CLIENT_ID, sub: 'google-user-1', email: 'bailey@example.com', email_verified: true,
        nonce: grant.nonce, iat: nowSec, exp: nowSec + 300, ...tweak.claims,
      };
      const idToken = signJwt(claims, privateKey, kid);
      return send(200, { access_token: 'access', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    send(404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    issuer,
    /** What the provider's sign-in page does: remember the request, then send back a code. */
    approve(authorizationUrl) {
      const params = new URL(authorizationUrl).searchParams;
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { challenge: params.get('code_challenge'), nonce: params.get('nonce') });
      if (params.get('response_mode') === 'form_post') {
        return { form: new URLSearchParams({ code, state: params.get('state') }) };
      }
      return { search: `?code=${code}&state=${params.get('state')}` };
    },
  };
}

/** openid-client wraps the specific failure in error.cause; match against both. */
function failsWith(pattern) {
  return (error) => {
    const text = `${error?.message} ${error?.cause?.message ?? ''} ${error?.code ?? ''} ${error?.cause?.code ?? ''} ${error?.error ?? ''}`;
    assert.match(text, pattern);
    return true;
  };
}

function provider(issuer) {
  return createOidcProvider({ issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, allowHttp: true });
}

test('start sends the browser to the provider with PKCE, state and nonce', async (t) => {
  const fake = await startFakeProvider(t);
  const { url, pending } = await provider(fake.issuer).start();
  const params = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, `${fake.issuer}/authorize`);
  assert.equal(params.get('client_id'), CLIENT_ID);
  assert.equal(params.get('redirect_uri'), REDIRECT_URI);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('scope'), 'openid email');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('state'), pending.state);
  assert.equal(params.get('nonce'), pending.nonce);
  assert.ok(!url.includes(pending.verifier), 'the PKCE verifier must stay on the server');
  assert.ok(!url.includes(CLIENT_SECRET));
});

test('finish returns the verified account from a correctly signed ID token', async (t) => {
  const fake = await startFakeProvider(t);
  const google = provider(fake.issuer);
  const { url, pending } = await google.start();
  assert.deepEqual(await google.finish(fake.approve(url), pending), {
    subject: 'google-user-1', email: 'bailey@example.com', emailVerified: true,
  });
});

test('finish rejects a callback whose state does not match', async (t) => {
  const fake = await startFakeProvider(t);
  const google = provider(fake.issuer);
  const { url, pending } = await google.start();
  const search = fake.approve(url).search.replace(/state=[^&]+/, 'state=forged');
  await assert.rejects(google.finish({ search }, pending), failsWith(/"state"/));
});

test('finish rejects an ID token for another app, another sign-in, another issuer, or one that expired', async (t) => {
  const cases = [
    [{ aud: 'someone-else' }, /"aud"/],
    [{ nonce: 'replayed' }, /"nonce"/],
    [{ exp: Math.floor(Date.now() / 1000) - 600 }, /"exp"/],
    [{ iss: 'https://evil.example.com' }, /"iss"/],
  ];
  for (const [claims, message] of cases) {
    const fake = await startFakeProvider(t, { claims });
    const google = provider(fake.issuer);
    const { url, pending } = await google.start();
    await assert.rejects(google.finish(fake.approve(url), pending), failsWith(message), JSON.stringify(claims));
  }
});

test('finish reports an unverified email as unverified', async (t) => {
  const fake = await startFakeProvider(t, { claims: { email_verified: false } });
  const google = provider(fake.issuer);
  const { url, pending } = await google.start();
  assert.equal((await google.finish(fake.approve(url), pending)).emailVerified, false);
});

test('finish fails when the PKCE verifier does not match the one sent at start', async (t) => {
  const fake = await startFakeProvider(t);
  const google = provider(fake.issuer);
  const { url, pending } = await google.start();
  await assert.rejects(google.finish(fake.approve(url), { ...pending, verifier: 'x'.repeat(43) }), failsWith(/invalid_grant/));
});

test('outside tests the provider refuses plain-HTTP connections', async (t) => {
  const fake = await startFakeProvider(t);
  const strict = createOidcProvider({ issuer: fake.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
  await assert.rejects(strict.start(), failsWith(/https/i));
});

// ---- Apple ----

const APPLE_REDIRECT = 'https://trader.example.com/api/auth/apple/callback';

function appleKeyFiles(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-apple-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const good = path.join(dir, 'AuthKey_TEST.p8');
  fs.writeFileSync(good, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const rsa = path.join(dir, 'rsa.pem');
  fs.writeFileSync(rsa, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { dir, good, rsa, publicKey };
}

const appleEnv = (keyPath, extra = {}) => ({
  APPLE_CLIENT_ID: 'com.example.trader.web', APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567',
  APPLE_PRIVATE_KEY_PATH: keyPath, GMGN_PUBLIC_URL: 'https://trader.example.com', ...extra,
});

test('appleSettings is off when unset, names what is missing, and needs https and a real key', (t) => {
  const keys = appleKeyFiles(t);
  assert.equal(appleSettings({}), null);
  assert.throws(() => appleSettings({ APPLE_CLIENT_ID: 'x' }), /APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY_PATH/);
  assert.throws(() => appleSettings(appleEnv(keys.good, { GMGN_PUBLIC_URL: 'http://localhost:5173' })), /https/);
  assert.throws(() => appleSettings(appleEnv(path.join(keys.dir, 'missing.p8'))), /cannot read the Apple key .*ENOENT/);
  assert.throws(() => appleSettings(appleEnv(keys.rsa)), /not an Apple sign-in key/);
  assert.throws(() => appleSettings(appleEnv('relative/key.p8')), /absolute/);
  const settings = appleSettings(appleEnv('~/AuthKey_TEST.p8'), keys.dir);
  assert.equal(settings.redirectUri, APPLE_REDIRECT);
  assert.equal(settings.clientId, 'com.example.trader.web');
});

/** Checks an Apple client secret the way Apple does: ES256 signature, kid, iss, sub, aud and lifetime. */
function verifyAppleSecret(token, publicKey, audience) {
  const [head, body, signature] = String(token).split('.');
  const ok = crypto.verify('sha256', Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature || '', 'base64url'));
  const header = JSON.parse(Buffer.from(head, 'base64url'));
  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  const nowSec = Math.floor(Date.now() / 1000);
  return ok && header.alg === 'ES256' && header.kid === 'KEY1234567' && claims.iss === 'TEAM123456'
    && claims.sub === 'com.example.trader.web' && claims.aud === audience
    && claims.iat <= nowSec && claims.exp > nowSec && claims.exp - claims.iat <= 300;
}

test('the Apple client secret is a short-lived ES256 token Apple can check', (t) => {
  const keys = appleKeyFiles(t);
  const settings = appleSettings(appleEnv(keys.good));
  const secret = createAppleClientSecret({ ...settings });
  assert.equal(verifyAppleSecret(secret, keys.publicKey, 'https://appleid.apple.com'), true);
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey;
  assert.equal(verifyAppleSecret(secret, other, 'https://appleid.apple.com'), false);
});

test('Apple sign-in returns by form POST and pays with a fresh signed client secret', async (t) => {
  const keys = appleKeyFiles(t);
  const secrets = [];
  const fake = await startFakeProvider(t, {
    redirectUri: APPLE_REDIRECT,
    claims: { aud: 'com.example.trader.web', email_verified: 'true', sub: 'apple-user-1' },
    checkClient: (form, issuer) => {
      secrets.push(form.get('client_secret'));
      return form.get('client_id') === 'com.example.trader.web' && verifyAppleSecret(form.get('client_secret'), keys.publicKey, issuer);
    },
  });
  const settings = { ...appleSettings(appleEnv(keys.good)), issuer: fake.issuer };
  const apple = createAppleProvider(settings, {
    allowHttp: true,
    serverMetadata: { issuer: fake.issuer, authorization_endpoint: `${fake.issuer}/authorize`,
      token_endpoint: `${fake.issuer}/token`, jwks_uri: `${fake.issuer}/jwks` },
  });
  assert.equal(apple.responseMode, 'form_post');
  const { url, pending } = await apple.start();
  const params = new URL(url).searchParams;
  assert.equal(params.get('response_mode'), 'form_post');
  assert.equal(params.get('redirect_uri'), APPLE_REDIRECT);
  assert.equal(params.get('client_id'), 'com.example.trader.web');

  const account = await apple.finish(fake.approve(url), pending);
  assert.deepEqual(account, { subject: 'apple-user-1', email: 'bailey@example.com', emailVerified: true });
  assert.equal(secrets.length, 1);
});
