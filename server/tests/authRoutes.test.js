import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { createAuthStore } from '../authStore.js';
import { OAUTH_COOKIE, SESSION_COOKIE, parseAllowedEmails, registerAuthRoutes } from '../authRoutes.js';

const ALLOWED = 'bailey@example.com';
const PASSWORD = 'correct horse battery';
const LOCKOUT_MS = 15 * 60 * 1000;

/** Starts a small app with the auth routes and one protected route. */
async function startApp(t, { allowed = ALLOWED, production = false, google = null, apple = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-auth-routes-'));
  const clock = { now: 1_000_000 };
  const settings = { allowed };
  const app = express();
  app.use(express.json());
  app.use('/api', registerAuthRoutes(app, {
    openStore: () => createAuthStore({ file: path.join(dir, 'auth.sqlite'), now: () => clock.now }),
    allowedEmails: () => parseAllowedEmails(settings.allowed),
    secureCookies: () => production,
    now: () => clock.now,
    externalProviders: { google: () => google, apple: () => apple },
  }));
  app.get('/api/protected', (req, res) => res.json({ ok: true, email: req.user.email }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, { body, cookie, contentType = 'application/json' } = {}) {
    const res = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(contentType ? { 'content-type': contentType } : {}), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
    return { status: res.status, body: await res.json(), setCookie, cookie: match?.[1] ? `${SESSION_COOKIE}=${match[1]}` : '' };
  }
  /** GET without following redirects; returns the target and every cookie set. */
  async function visit(route, cookie, form) {
    const res = await fetch(base + route, {
      redirect: 'manual',
      method: form ? 'POST' : 'GET',
      headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    return { status: res.status, location: res.headers.get('location'), cookies: res.headers.getSetCookie() };
  }
  return { call, visit, clock, settings };
}

test('parseAllowedEmails normalizes entries and rejects malformed ones', () => {
  assert.deepEqual([...parseAllowedEmails(' A@Example.com, b@example.com ,')], ['a@example.com', 'b@example.com']);
  assert.equal(parseAllowedEmails(undefined).size, 0);
  assert.equal(parseAllowedEmails('').size, 0);
  assert.throws(() => parseAllowedEmails('a@example.com, not-an-email'), /GMGN_ALLOWED_EMAILS/);
});

test('sign-up is limited to allow-listed emails and starts a session', async (t) => {
  const { call } = await startApp(t);
  const stranger = await call('/api/auth/signup', { body: { email: 'stranger@example.com', password: PASSWORD } });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.cookie, '');

  assert.equal((await call('/api/auth/signup', { body: { email: ALLOWED, password: 'short' } })).status, 400);
  assert.equal((await call('/api/auth/signup', { body: { email: 'nope', password: PASSWORD } })).status, 400);

  const created = await call('/api/auth/signup', { body: { email: 'Bailey@Example.com', password: PASSWORD } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { ok: true, user: { email: ALLOWED } });
  assert.match(created.setCookie, /HttpOnly/i);
  assert.match(created.setCookie, /SameSite=Lax/i);
  assert.match(created.setCookie, /Path=\//);
  assert.doesNotMatch(created.setCookie, /Secure/i, 'plain-HTTP local development cannot use Secure cookies');

  assert.deepEqual((await call('/api/auth/me', { cookie: created.cookie })).body, { ok: true, user: { email: ALLOWED } });
  assert.equal((await call('/api/auth/signup', { body: { email: ALLOWED, password: PASSWORD } })).status, 409);
});

test('session cookies are marked Secure in production', async (t) => {
  const { call } = await startApp(t, { production: true });
  const created = await call('/api/auth/signup', { body: { email: ALLOWED, password: PASSWORD } });
  assert.match(created.setCookie, /;\s*Secure/i);
});

test('auth routes that change state accept JSON only', async (t) => {
  const { call } = await startApp(t);
  for (const route of ['/api/auth/signup', '/api/auth/signin', '/api/auth/signout']) {
    const res = await call(route, { body: { email: ALLOWED, password: PASSWORD }, contentType: 'text/plain' });
    assert.equal(res.status, 415, route);
  }
});

test('sign-in gives the same answer for a wrong password and an unknown email', async (t) => {
  const { call } = await startApp(t);
  await call('/api/auth/signup', { body: { email: ALLOWED, password: PASSWORD } });
  const wrong = await call('/api/auth/signin', { body: { email: ALLOWED, password: 'wrong password!!' } });
  const unknown = await call('/api/auth/signin', { body: { email: 'nobody@example.com', password: PASSWORD } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown, wrong);

  const ok = await call('/api/auth/signin', { body: { email: ' BAILEY@example.com', password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);
  assert.equal((await call('/api/protected', { cookie: ok.cookie })).body.email, ALLOWED);
});

test('repeated wrong passwords lock the email out for the window, even with the right password', async (t) => {
  const { call, clock } = await startApp(t);
  await call('/api/auth/signup', { body: { email: ALLOWED, password: PASSWORD } });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call('/api/auth/signin', { body: { email: ALLOWED, password: `wrong password ${i}` } })).status, 401);
  }
  const locked = await call('/api/auth/signin', { body: { email: ALLOWED, password: PASSWORD } });
  assert.equal(locked.status, 429);
  assert.equal(locked.cookie, '');

  clock.now += LOCKOUT_MS;
  assert.equal((await call('/api/auth/signin', { body: { email: ALLOWED, password: PASSWORD } })).status, 200);
});

test('many failures from one address lock that address out across emails', async (t) => {
  const { call } = await startApp(t);
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await call('/api/auth/signin', { body: { email: `guess${i}@example.com`, password: PASSWORD } })).status, 401);
  }
  assert.equal((await call('/api/auth/signin', { body: { email: 'another@example.com', password: PASSWORD } })).status, 429);
  assert.equal((await call('/api/auth/signup', { body: { email: ALLOWED, password: PASSWORD } })).status, 429);
});

test('other API routes need a session, and sign-out ends it', async (t) => {
  const { call } = await startApp(t);
  assert.deepEqual(await call('/api/protected').then(r => [r.status, r.body.code]), [401, 'SIGN_IN_REQUIRED']);
  assert.equal((await call('/api/protected', { cookie: `${SESSION_COOKIE}=made-up` })).status, 401);
  assert.equal((await call('/api/auth/me')).status, 401);

  const { cookie } = await call('/api/auth/signup', { body: { email: ALLOWED, password: PASSWORD } });
  assert.equal((await call('/api/protected', { cookie })).status, 200);

  const out = await call('/api/auth/signout', { body: {}, cookie });
  assert.equal(out.status, 200);
  assert.match(out.setCookie, new RegExp(`${SESSION_COOKIE}=;`));
  assert.equal((await call('/api/protected', { cookie })).status, 401, 'old cookie must stop working');
});

test('removing an email from the allow-list ends its access', async (t) => {
  const { call, settings } = await startApp(t);
  const { cookie } = await call('/api/auth/signup', { body: { email: ALLOWED, password: PASSWORD } });
  settings.allowed = 'someone-else@example.com';
  assert.equal((await call('/api/protected', { cookie })).status, 401);
  assert.equal((await call('/api/auth/signin', { body: { email: ALLOWED, password: PASSWORD } })).status, 401);
  settings.allowed = ALLOWED;
  assert.equal((await call('/api/protected', { cookie })).status, 401, 'ended session stays ended');
});

test('sessions expire after seven days', async (t) => {
  const { call, clock } = await startApp(t);
  const { cookie } = await call('/api/auth/signup', { body: { email: ALLOWED, password: PASSWORD } });
  clock.now += 7 * 24 * 60 * 60 * 1000;
  assert.equal((await call('/api/protected', { cookie })).status, 401);
});

test('the real server requires sign-in on its API routes', async (t) => {
  const old = { db: process.env.GMGN_AUTH_DB_PATH, allowed: process.env.GMGN_ALLOWED_EMAILS };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-auth-real-'));
  process.env.GMGN_AUTH_DB_PATH = path.join(dir, 'auth.sqlite');
  process.env.GMGN_ALLOWED_EMAILS = ALLOWED;
  const { app } = await import('../index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['GMGN_AUTH_DB_PATH', old.db], ['GMGN_ALLOWED_EMAILS', old.allowed]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/api/health', '/api/research/scans', '/api/paper/portfolio']) {
    assert.equal((await fetch(base + route)).status, 401, route);
  }
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ALLOWED, password: PASSWORD }),
  });
  assert.equal(signup.status, 201);
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/health`, { headers: { cookie } })).status, 200);
});

/** Stands in for Google (or Apple with responseMode 'form_post'): finish() returns whatever account the test sets. */
function fakeGoogle(account = { subject: 'google-sub-1', email: ALLOWED, emailVerified: true }, responseMode = 'query') {
  const fake = {
    responseMode,
    account,
    finished: [],
    async start() {
      return { url: 'https://accounts.example.test/authorize?state=s1', pending: { verifier: 'v1', state: 's1', nonce: 'n1' } };
    },
    async finish(response, pending) {
      fake.finished.push({ response, pending });
      return fake.account;
    },
  };
  return fake;
}

const cookieValue = (cookies, name) => cookies.map(c => c.match(new RegExp(`^${name}=([^;]*)`))?.[1]).find(Boolean) || '';

async function googleRoundTrip(visit, query = 'code=abc&state=s1') {
  const start = await visit('/api/auth/google/start');
  const oauthCookie = `${OAUTH_COOKIE}=${cookieValue(start.cookies, OAUTH_COOKIE)}`;
  const callback = await visit(`/api/auth/google/callback?${query}`, oauthCookie);
  return { start, callback, oauthCookie, session: cookieValue(callback.cookies, SESSION_COOKIE) };
}

test('providers report whether Google sign-in is set up', async (t) => {
  assert.deepEqual((await (await startApp(t)).call('/api/auth/providers')).body, { ok: true, google: false, apple: false });
  assert.deepEqual((await (await startApp(t, { google: fakeGoogle() })).call('/api/auth/providers')).body, { ok: true, google: true, apple: false });
  assert.deepEqual((await (await startApp(t, { apple: fakeGoogle() })).call('/api/auth/providers')).body, { ok: true, google: false, apple: true });
});

test('Google start sends the browser to Google with a short-lived private cookie', async (t) => {
  const { visit } = await startApp(t, { google: fakeGoogle() });
  const start = await visit('/api/auth/google/start');
  assert.equal(start.status, 303);
  assert.equal(start.location, 'https://accounts.example.test/authorize?state=s1');
  const cookie = start.cookies.find(c => c.startsWith(`${OAUTH_COOKIE}=`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\/api\/auth\/google/);
  assert.match(cookie, /Max-Age=600/);
  assert.doesNotMatch(cookie, /v1|s1|n1/, 'the cookie holds only a random id, not the PKCE or state values');
});

test('Google start without a configuration returns to the page with a reason', async (t) => {
  const { visit } = await startApp(t);
  const start = await visit('/api/auth/google/start');
  assert.equal(start.status, 303);
  assert.equal(start.location, '/?signin_error=not_configured&signin_provider=google');
});

test('a Google callback signs in an allow-listed, verified account and can be used only once', async (t) => {
  const google = fakeGoogle();
  const { visit, call } = await startApp(t, { google });
  const { callback, oauthCookie, session } = await googleRoundTrip(visit);
  assert.equal(callback.status, 303);
  assert.equal(callback.location, '/');
  assert.ok(session, 'a session cookie is set');
  assert.deepEqual(google.finished[0].response, { search: '?code=abc&state=s1' });
  assert.deepEqual(google.finished[0].pending.state, 's1');
  assert.deepEqual((await call('/api/auth/me', { cookie: `${SESSION_COOKIE}=${session}` })).body.user, { email: ALLOWED });

  const replay = await visit('/api/auth/google/callback?code=abc&state=s1', oauthCookie);
  assert.equal(replay.location, '/?signin_error=expired&signin_provider=google');
  assert.equal(cookieValue(replay.cookies, SESSION_COOKIE), '');
});

test('a Google callback without the start cookie, or after ten minutes, is refused', async (t) => {
  const { visit, clock } = await startApp(t, { google: fakeGoogle() });
  assert.equal((await visit('/api/auth/google/callback?code=abc&state=s1')).location, '/?signin_error=expired&signin_provider=google');
  const start = await visit('/api/auth/google/start');
  clock.now += 10 * 60 * 1000;
  const late = await visit('/api/auth/google/callback?code=abc&state=s1', `${OAUTH_COOKIE}=${cookieValue(start.cookies, OAUTH_COOKIE)}`);
  assert.equal(late.location, '/?signin_error=expired&signin_provider=google');
});

test('Google sign-in is refused for emails off the allow-list, unverified emails, cancels and failures', async (t) => {
  const google = fakeGoogle();
  const { visit } = await startApp(t, { google });
  google.account = { subject: 'g2', email: 'stranger@example.com', emailVerified: true };
  assert.equal((await googleRoundTrip(visit)).callback.location, '/?signin_error=not_allowed&signin_provider=google');
  google.account = { subject: 'g3', email: ALLOWED, emailVerified: false };
  assert.equal((await googleRoundTrip(visit)).callback.location, '/?signin_error=unverified&signin_provider=google');
  assert.equal((await googleRoundTrip(visit, 'error=access_denied&state=s1')).callback.location, '/?signin_error=cancelled&signin_provider=google');
  google.finish = async () => { throw new Error('token exchange failed'); };
  const failed = await googleRoundTrip(visit);
  assert.equal(failed.callback.location, '/?signin_error=failed&signin_provider=google');
  assert.equal(failed.session, '');
});

test('Google sign-in joins the existing email account instead of making a second one', async (t) => {
  const google = fakeGoogle();
  const { visit, call } = await startApp(t, { google });
  await call('/api/auth/signup', { body: { email: ALLOWED, password: PASSWORD } });
  const first = await googleRoundTrip(visit);
  assert.ok(first.session);
  // The same Google account comes back with a changed address: still the same user.
  google.account = { ...google.account, email: 'BAILEY@example.com' };
  const second = await googleRoundTrip(visit);
  assert.equal((await call('/api/auth/me', { cookie: `${SESSION_COOKIE}=${second.session}` })).body.user.email, ALLOWED);
  // Password sign-in still works for the joined account.
  assert.equal((await call('/api/auth/signin', { body: { email: ALLOWED, password: PASSWORD } })).status, 200);
});

test('Apple returns with a form POST; its start cookie must survive that cross-site POST', async (t) => {
  const apple = fakeGoogle({ subject: 'apple-sub-1', email: ALLOWED, emailVerified: true }, 'form_post');
  const { visit, call } = await startApp(t, { apple });
  const start = await visit('/api/auth/apple/start');
  assert.equal(start.status, 303);
  const cookie = start.cookies.find(c => c.startsWith(`${OAUTH_COOKIE}=`));
  assert.match(cookie, /SameSite=None/i);
  assert.match(cookie, /;\s*Secure/i);
  assert.match(cookie, /Path=\/api\/auth\/apple/);
  const oauthCookie = `${OAUTH_COOKIE}=${cookieValue(start.cookies, OAUTH_COOKIE)}`;

  const callback = await visit('/api/auth/apple/callback', oauthCookie, { code: 'abc', state: 's1' });
  assert.equal(callback.status, 303);
  assert.equal(callback.location, '/');
  assert.equal(apple.finished[0].response.form.get('code'), 'abc');
  const session = cookieValue(callback.cookies, SESSION_COOKIE);
  assert.deepEqual((await call('/api/auth/me', { cookie: `${SESSION_COOKIE}=${session}` })).body.user, { email: ALLOWED });

  const cancel = await visit('/api/auth/apple/start');
  const cancelled = await visit('/api/auth/apple/callback', `${OAUTH_COOKIE}=${cookieValue(cancel.cookies, OAUTH_COOKIE)}`,
    { error: 'user_cancelled_authorize', state: 's1' });
  assert.equal(cancelled.location, '/?signin_error=cancelled&signin_provider=apple');
});

test('a sign-in started with Google cannot be finished at the Apple address', async (t) => {
  const { visit } = await startApp(t, { google: fakeGoogle(), apple: fakeGoogle(undefined, 'form_post') });
  const start = await visit('/api/auth/google/start');
  const crossed = await visit('/api/auth/apple/callback', `${OAUTH_COOKIE}=${cookieValue(start.cookies, OAUTH_COOKIE)}`,
    { code: 'abc', state: 's1' });
  assert.equal(crossed.location, '/?signin_error=expired&signin_provider=apple');
});
