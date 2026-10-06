import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWindowCounter } from '../rateLimit.js';

const TOKEN = 'rate-limit-test-token-0123456789abcdef';
const AUTH_LIMIT = 3;
const REQUEST_LIMIT = 30;

test('window counter allows up to max per key, then resets after the window', () => {
  let t = 0;
  const counter = createWindowCounter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(counter.hit('a').allowed, true);
  assert.equal(counter.hit('a').allowed, true);
  const third = counter.hit('a');
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterSeconds, 1);
  assert.equal(counter.hit('b').allowed, true, 'keys are counted separately');
  t = 1000;
  assert.equal(counter.hit('a').allowed, true, 'a new window starts fresh');
});

test('window counter rejects invalid limits', () => {
  assert.throws(() => createWindowCounter({ windowMs: 1000, max: 0 }), /max/);
  assert.throws(() => createWindowCounter({ windowMs: 0, max: 1 }), /windowMs/);
});

async function startApp(t) {
  const saved = Object.fromEntries(['GMGN_LOCAL_TOKEN', 'GMGN_AUTH_FAILURES_PER_15_MIN', 'GMGN_API_REQUESTS_PER_MIN']
    .map(k => [k, process.env[k]]));
  process.env.GMGN_LOCAL_TOKEN = TOKEN;
  process.env.GMGN_AUTH_FAILURES_PER_15_MIN = String(AUTH_LIMIT);
  process.env.GMGN_API_REQUESTS_PER_MIN = String(REQUEST_LIMIT);
  const { app } = await import('../index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// The proxy sets X-Forwarded-For; each test uses its own visitor address so counts do not mix.
const get = (base, visitor, token) => fetch(`${base}/api/paper/portfolio`, {
  headers: { 'x-forwarded-for': visitor, ...(token ? { 'x-gmgn-token': token } : {}) },
});

test('repeated wrong tokens lock out that visitor only, even for the correct token', async t => {
  const base = await startApp(t);
  for (let i = 0; i < AUTH_LIMIT; i += 1) {
    assert.equal((await get(base, '203.0.113.7', 'wrong-token')).status, 401);
  }
  const locked = await get(base, '203.0.113.7', TOKEN);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await get(base, '198.51.100.9', TOKEN)).status, 200, 'other visitors are unaffected');
});

test('requests above the per-minute limit get 429 for that visitor only', async t => {
  const base = await startApp(t);
  const statuses = [];
  for (let i = 0; i <= REQUEST_LIMIT; i += 1) statuses.push((await get(base, '192.0.2.44', TOKEN)).status);
  assert.deepEqual(statuses.slice(0, REQUEST_LIMIT), Array(REQUEST_LIMIT).fill(200));
  assert.equal(statuses[REQUEST_LIMIT], 429);
  assert.equal((await get(base, '192.0.2.45', TOKEN)).status, 200);
});

test('requests without a token, or with only Basic credentials, never trigger the lockout', async t => {
  const base = await startApp(t);
  const visitor = '203.0.113.50';
  for (let i = 0; i < AUTH_LIMIT + 2; i += 1) {
    assert.equal((await get(base, visitor)).status, 401);
    const basic = await fetch(`${base}/api/paper/portfolio`, {
      headers: { 'x-forwarded-for': visitor, authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(basic.status, 401);
  }
  assert.equal((await get(base, visitor, TOKEN)).status, 200);
  const bearer = await fetch(`${base}/api/paper/portfolio`, {
    headers: { 'x-forwarded-for': '203.0.113.51', authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(bearer.status, 200, 'Bearer tokens still work');
});
