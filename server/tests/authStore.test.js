import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  PASSWORD_MIN_LENGTH,
  SESSION_TTL_MS,
  createAuthStore,
  hashPassword,
  normalizeEmail,
  verifyPasswordHash,
} from '../authStore.js';

const PASSWORD = 'correct horse battery';

function tempStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-auth-'));
  const file = path.join(dir, 'auth.sqlite');
  const store = createAuthStore({ file, ...options });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, file };
}

test('normalizeEmail trims and lower-cases, and rejects invalid addresses', () => {
  assert.equal(normalizeEmail('  Bailey@Example.COM '), 'bailey@example.com');
  for (const bad of ['', 'no-at-sign', 'a@b', 'a b@c.d', `${'x'.repeat(250)}@e.com`, null]) {
    assert.throws(() => normalizeEmail(bad), { status: 400, code: 'INVALID_EMAIL' }, String(bad));
  }
});

test('password hashes are salted and verify only the right password', async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);
  assert.notEqual(a, b, 'same password must give different hashes');
  assert.ok(!a.includes(PASSWORD));
  assert.equal(await verifyPasswordHash(PASSWORD, a), true);
  assert.equal(await verifyPasswordHash('wrong password!!', a), false);
  assert.equal(await verifyPasswordHash(PASSWORD, 'not-a-hash'), false);
  assert.equal(await verifyPasswordHash(PASSWORD, a.replace(/^scrypt\$32768/, 'scrypt$2')), false);
});

test('database file is private and never contains the plain password', async (t) => {
  const { store, file } = tempStore(t);
  await store.createUser('bailey@example.com', PASSWORD);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file).includes(PASSWORD));
});

test('createUser rejects short passwords and duplicate emails', async (t) => {
  const { store } = tempStore(t);
  await assert.rejects(store.createUser('a@example.com', 'x'.repeat(PASSWORD_MIN_LENGTH - 1)), {
    status: 400,
    code: 'WEAK_PASSWORD',
  });
  const user = await store.createUser('A@Example.com', PASSWORD);
  assert.deepEqual(user, { id: user.id, email: 'a@example.com' });
  await assert.rejects(store.createUser('a@EXAMPLE.com', PASSWORD), { status: 409, code: 'EMAIL_TAKEN' });
});

test('checkPassword returns the user only for the right email and password', async (t) => {
  const { store } = tempStore(t);
  const user = await store.createUser('bailey@example.com', PASSWORD);
  assert.deepEqual(await store.checkPassword(' Bailey@example.com', PASSWORD), user);
  assert.equal(await store.checkPassword('bailey@example.com', 'wrong password!!'), null);
  assert.equal(await store.checkPassword('nobody@example.com', PASSWORD), null);
  assert.equal(await store.checkPassword('not an email', PASSWORD), null);
  assert.equal(await store.checkPassword('bailey@example.com', undefined), null);
});

test('sessions resolve to their user, end on sign-out, and expire after the TTL', async (t) => {
  let clock = 1_000_000;
  const { store } = tempStore(t, { now: () => clock });
  const user = await store.createUser('bailey@example.com', PASSWORD);

  const { token, expiresAt } = store.createSession(user.id);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresAt, clock + SESSION_TTL_MS);
  assert.deepEqual(store.getSession(token), { userId: user.id, email: user.email, expiresAt });

  assert.equal(store.getSession('made-up-token'), null);
  assert.equal(store.getSession(''), null);
  assert.equal(store.getSession(undefined), null);

  store.deleteSession(token);
  assert.equal(store.getSession(token), null);

  const second = store.createSession(user.id);
  clock += SESSION_TTL_MS;
  assert.equal(store.getSession(second.token), null, 'expired session must not resolve');
});

test('session tokens are stored only as hashes', async (t) => {
  const { store, file } = tempStore(t);
  const user = await store.createUser('bailey@example.com', PASSWORD);
  const { token } = store.createSession(user.id);
  assert.ok(!fs.readFileSync(file).includes(token));
});
