import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSignedInSession } from './authSession.js';

const TOKEN = 'production-test-token-0123456789abcdef';

test('production requires a configured token of at least 32 characters', async () => {
  const { assertProductionToken } = await import('../index.js');
  assert.throws(() => assertProductionToken(''), /must be set/);
  assert.throws(() => assertProductionToken('short-token'), /at least 32 characters/);
  assert.doesNotThrow(() => assertProductionToken(TOKEN));
});

test('production refuses to save credentials from the browser', async t => {
  const oldEnv = process.env.NODE_ENV;
  const oldToken = process.env.GMGN_LOCAL_TOKEN;
  process.env.NODE_ENV = 'production';
  process.env.GMGN_LOCAL_TOKEN = TOKEN;
  const session = await createSignedInSession();
  const { app } = await import('../index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    session.cleanup();
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldToken === undefined) delete process.env.GMGN_LOCAL_TOKEN; else process.env.GMGN_LOCAL_TOKEN = oldToken;
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gmgn-token': TOKEN, cookie: session.cookie },
    body: JSON.stringify({ walletAddress: 'So11111111111111111111111111111111111111112' }),
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /disabled in production/);
});
