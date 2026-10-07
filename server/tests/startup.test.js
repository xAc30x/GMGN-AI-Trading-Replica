import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverEntry = fileURLToPath(new URL('../index.js', import.meta.url));

test('server exits with an error instead of claiming to listen when its port is busy', async () => {
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  const dir = mkdtempSync(join(tmpdir(), 'gmgn-startup-test-'));
  try {
    const child = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        PORT: String(port),
        GMGN_LOCAL_TOKEN: 'startup-test-token',
        GMGN_SECRETS_PATH: join(dir, 'missing-secrets.json'),
        GMGN_RESEARCH_DB_PATH: join(dir, 'research.sqlite'),
        GMGN_PORTFOLIO_LEDGER_PATH: join(dir, 'portfolio.sqlite'),
        GMGN_TRADE_LEDGER_PATH: join(dir, 'trades.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const code = await new Promise(resolve => child.on('exit', resolve));
    clearTimeout(timer);
    assert.equal(code, 1, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stderr, new RegExp(`Port ${port} on 127\\.0\\.0\\.1 is already in use`));
    assert.doesNotMatch(stdout, /listening on/);
  } finally {
    blocker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
