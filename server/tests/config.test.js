import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
