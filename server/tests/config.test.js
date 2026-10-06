import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('file configuration is loaded before Jupiter constants initialize', () => {
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const tmp=mkdtempSync(root+'node_modules/.gmgn-config-test-');
  try {
    copyFileSync(root+'server/config.js',tmp+'/config.js');
    copyFileSync(root+'server/jupiterSol.js',tmp+'/jupiterSol.js');
    writeFileSync(tmp+'/package.json','{"type":"module"}');
    writeFileSync(tmp+'/.env','GMGN_MAX_SLIPPAGE_BPS=222\nGMGN_MAX_PRICE_IMPACT_PCT=2\n');
    const env={ ...process.env };
    delete env.GMGN_MAX_SLIPPAGE_BPS; delete env.GMGN_MAX_PRICE_IMPACT_PCT;
    const result=spawnSync(process.execPath,['--input-type=module','-e',
      'import { MAX_SLIPPAGE_BPS, MAX_PRICE_IMPACT_PCT } from '+JSON.stringify(tmp+'/jupiterSol.js')+
      '; console.log(JSON.stringify([MAX_SLIPPAGE_BPS,MAX_PRICE_IMPACT_PCT]));'],{ env,encoding:'utf8' });
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()),[222,2]);
  } finally { rmSync(tmp,{ recursive:true,force:true }); }
});

test('secrets file path defaults under ~/.config and honours GMGN_SECRETS_PATH', async () => {
  const { secretsFilePath } = await import('../config.js');
  const home = '/home/someone';
  assert.equal(secretsFilePath({}, home), '/home/someone/.config/gmgn-trader/secrets.json');
  assert.equal(secretsFilePath({ GMGN_SECRETS_PATH: '  ' }, home), '/home/someone/.config/gmgn-trader/secrets.json');
  assert.equal(secretsFilePath({ GMGN_SECRETS_PATH: '/srv/app/secrets.json' }, home), '/srv/app/secrets.json');
  assert.equal(secretsFilePath({ GMGN_SECRETS_PATH: '~/private/s.json' }, home), '/home/someone/private/s.json');
  assert.throws(() => secretsFilePath({ GMGN_SECRETS_PATH: 'relative/s.json' }, home), /GMGN_SECRETS_PATH/);
});

test('secrets file loads only the allowed keys and never overrides existing values', async () => {
  const { loadSecretsFile } = await import('../config.js');
  const dir = mkdtempSync(join(tmpdir(), 'gmgn-secrets-test-'));
  try {
    const file = join(dir, 'secrets.json');
    writeFileSync(file, JSON.stringify({ card: {
      GMGN_API_KEY: ' key-from-file ', GMGN_WALLET_ADDRESS: 'wallet-from-file',
      GMGN_PRIVATE_KEY: 'must-not-load', GMGN_LIVE: '1',
    } }));
    const env = { GMGN_WALLET_ADDRESS: 'wallet-from-env' };
    const warnings = [];
    loadSecretsFile(file, env, (m) => warnings.push(m));
    assert.deepEqual(env, { GMGN_WALLET_ADDRESS: 'wallet-from-env', GMGN_API_KEY: 'key-from-file' });
    assert.deepEqual(warnings, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing secrets file is silent; malformed file warns without revealing contents', async () => {
  const { loadSecretsFile } = await import('../config.js');
  const dir = mkdtempSync(join(tmpdir(), 'gmgn-secrets-test-'));
  try {
    const warnings = [];
    const env = {};
    loadSecretsFile(join(dir, 'absent.json'), env, (m) => warnings.push(m));
    assert.deepEqual(warnings, []);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"card": {"GMGN_API_KEY": "secret-value-123"');
    loadSecretsFile(bad, env, (m) => warnings.push(m));
    const noCard = join(dir, 'nocard.json');
    writeFileSync(noCard, '{"GMGN_API_KEY": "secret-value-123"}');
    loadSecretsFile(noCard, env, (m) => warnings.push(m));

    assert.equal(warnings.length, 2);
    assert.ok(warnings[0].includes(bad));
    assert.ok(warnings[1].includes(noCard));
    for (const w of warnings) assert.ok(!w.includes('secret-value-123'));
    assert.deepEqual(env, {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
