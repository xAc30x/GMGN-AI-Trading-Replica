import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserRpcOrigins, contentSecurityPolicy } from '../securityHeaders.js';

test('browser RPC origins allow only the configured http(s) host and its websocket', () => {
  assert.deepEqual(browserRpcOrigins(''), []);
  assert.deepEqual(browserRpcOrigins(undefined), []);
  assert.deepEqual(browserRpcOrigins('not a url'), []);
  assert.deepEqual(browserRpcOrigins('javascript:alert(1)'), []);
  assert.deepEqual(browserRpcOrigins('https://rpc.example.com/v1/path?api-key=abc'),
    ['https://rpc.example.com', 'wss://rpc.example.com']);
});

test('content security policy keeps scripts same-origin and forbids framing', () => {
  const csp = contentSecurityPolicy();
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /connect-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  const withRpc = contentSecurityPolicy({ browserRpcUrl: 'https://rpc.example.com/?api-key=secret' });
  assert.match(withRpc, /connect-src 'self' https:\/\/rpc\.example\.com wss:\/\/rpc\.example\.com/);
  assert.doesNotMatch(withRpc, /secret/, 'API keys in the RPC URL never reach the header');
});

test('every response carries the security headers and hides the framework', async t => {
  const { app } = await import('../index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/api/health', '/api/paper/portfolio']) {
    const res = await fetch(base + route);
    await res.arrayBuffer();
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, route);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', route);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', route);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', route);
    assert.equal(res.headers.get('x-powered-by'), null, route);
  }
});
