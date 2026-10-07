import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSignedInSession } from './authSession.js';
import { REDACTED, jsonErrorHandler, redactText, sanitizeBody, secretValues } from '../errorSafety.js';

const RPC_KEY = 'rpc-api-key-0123456789';
const RPC_URL = `https://mainnet.helius-rpc.example/?api-key=${RPC_KEY}`;

test('secret values come only from configured, non-trivial environment entries', () => {
  assert.deepEqual(secretValues({ SOLANA_RPC_URL: RPC_URL, GMGN_API_KEY: 'short', OTHER: 'not-a-secret-value' }), [RPC_URL]);
  assert.deepEqual(secretValues({ GOOGLE_CLIENT_SECRET: 'google-client-secret-value' }), ['google-client-secret-value']);
});

test('diagnostic text loses configured secrets and URL paths and queries', () => {
  const secrets = [RPC_URL, 'gmgn-api-key-abcdef'];
  assert.equal(redactText(`Failed to parse URL from ${RPC_URL}`, secrets, { diagnostic: true }), `Failed to parse URL from ${REDACTED}`);
  assert.equal(redactText('GET https://rpc.quicknode.example/abc123secret/ failed', [], { diagnostic: true }),
    'GET https://rpc.quicknode.example failed');
  assert.equal(redactText('key gmgn-api-key-abcdef rejected', secrets), `key ${REDACTED} rejected`);
});

test('response bodies keep normal URLs and data but scrub error fields', () => {
  const body = {
    ok: false,
    pairUrl: 'https://dexscreener.com/solana/abc',
    signature: '5'.repeat(88),
    error: { code: -32000, message: `RPC upstream failed: ${RPC_URL}` },
    safety: { blockers: [`lookup https://api.example/x?key=${RPC_KEY} failed`] },
  };
  const out = sanitizeBody(body, [RPC_URL]);
  assert.equal(out.pairUrl, body.pairUrl, 'non-error URLs are untouched');
  assert.equal(out.signature, body.signature);
  assert.equal(out.error.message, `RPC upstream failed: ${REDACTED}`);
  assert.equal(out.safety.blockers[0], 'lookup https://api.example failed');
  assert.ok(!JSON.stringify(out).includes(RPC_KEY));
});

test('unhandled errors answer with a generic message and log a redacted copy', () => {
  const logs = [];
  const handler = jsonErrorHandler({ env: { SOLANA_RPC_URL: RPC_URL }, log: m => logs.push(m) });
  const sent = {};
  const res = { headersSent: false, status(c) { sent.status = c; return this; }, json(b) { sent.body = b; } };
  handler(new Error(`boom ${RPC_URL}`), {}, res, () => {});
  assert.deepEqual(sent, { status: 500, body: { ok: false, error: 'Internal server error' } });
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes(RPC_KEY));
  handler(Object.assign(new Error('Unexpected token in JSON'), { status: 400 }), {}, res, () => {});
  assert.deepEqual(sent, { status: 400, body: { ok: false, error: 'Unexpected token in JSON' } });
});

test('the RPC proxy never returns the configured RPC URL in its error', async t => {
  const saved = { SOLANA_RPC_URL: process.env.SOLANA_RPC_URL, GMGN_LOCAL_TOKEN: process.env.GMGN_LOCAL_TOKEN };
  // A malformed URL makes fetch fail with "Failed to parse URL from <url>", quoting the key.
  process.env.SOLANA_RPC_URL = `http://bad host/${RPC_KEY}`;
  process.env.GMGN_LOCAL_TOKEN = 'error-safety-test-token-0123456789';
  const session = await createSignedInSession();
  const { app } = await import('../index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    session.cleanup();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = await fetch(`${base}/api/sol/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gmgn-token': process.env.GMGN_LOCAL_TOKEN, cookie: session.cookie },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
  });
  const text = await rpc.text();
  assert.equal(rpc.status, 502);
  assert.ok(!text.includes(RPC_KEY), text);
  const bad = await fetch(`${base}/api/sol/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gmgn-token': process.env.GMGN_LOCAL_TOKEN, cookie: session.cookie },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type') ?? '', /application\/json/);
  assert.equal((await bad.json()).ok, false);
});
