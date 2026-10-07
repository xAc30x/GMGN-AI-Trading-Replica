import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { createAuthStore } from '../authStore.js';
import { SESSION_COOKIE, parseAllowedEmails, registerAuthRoutes } from '../authRoutes.js';

const ALLOWED = 'bailey@example.com';
const PASSWORD = 'correct horse battery';
const LOCKOUT_MS = 15 * 60 * 1000;

/** Starts a small app with the auth routes and one protected route. */
async function startApp(t, { allowed = ALLOWED, production = false } = {}) {
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
  return { call, clock, settings };
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
  assert.equal((await call('/api/protected')).status, 401);
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
