import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  getPortfolioSnapshot,
  getWalletMintBalance,
  reservePortfolioBuy,
} from '../portfolioLedger.js';

const wallet = new PublicKey('11111111111111111111111111111111').toBase58();
const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function connection({ slot = 100, amount = '0' } = {}) {
  return {
    getParsedTokenAccountsByOwner: async (_owner, filter) => {
      const includeMint = filter.mint ? filter.mint.toBase58() === mint : amount !== '0';
      const tokenProgramFilter = filter.programId?.equals(tokenProgram);
      const rows = includeMint && (!filter.programId || tokenProgramFilter) ? [{
        account: { data: { parsed: { info: {
          mint,
          tokenAmount: { amount, decimals: 6 },
        } } } },
      }] : [];
      return { context: { slot }, value: rows };
    },
    getSlot: async () => 100,
    getBlockHeight: async () => 10,
    getSignatureStatuses: async () => ({ value: [null] }),
  };
}

async function isolatedLedger(t, action) {
  const oldPath = process.env.GMGN_PORTFOLIO_LEDGER_PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-portfolio-ledger-'));
  process.env.GMGN_PORTFOLIO_LEDGER_PATH = path.join(dir, 'ledger.sqlite');
  t.after(() => {
    if (oldPath === undefined) delete process.env.GMGN_PORTFOLIO_LEDGER_PATH;
    else process.env.GMGN_PORTFOLIO_LEDGER_PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return action();
}

test('concurrent buys reserve one shared portfolio cap atomically', async t => {
  await isolatedLedger(t, async () => {
    const rpc = connection();
    const reserve = tradeId => reservePortfolioBuy({
      connection: rpc,
      walletAddress: wallet,
      mint,
      tradeId,
      amountLamports: '60000000',
      maxPortfolioSol: 0.1,
      maxOpenPositions: 5,
    });
    const results = await Promise.allSettled([
      reserve('portfolio-trade-concurrent-1'),
      reserve('portfolio-trade-concurrent-2'),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /Portfolio cap exceeded/);
  });
});

test('independent server processes cannot over-reserve a shared SQLite ledger', async t => {
  await isolatedLedger(t, async () => {
    const database = process.env.GMGN_PORTFOLIO_LEDGER_PATH;
    const childScript = `
      import { reservePortfolioBuy } from './server/portfolioLedger.js';
      const connection = {
        getParsedTokenAccountsByOwner: async () => {
          await new Promise(resolve => setTimeout(resolve, 75));
          return { context: { slot: 100 }, value: [] };
        },
        getSlot: async () => 100,
        getBlockHeight: async () => 10,
        getSignatureStatuses: async () => ({ value: [null] }),
      };
      try {
        await reservePortfolioBuy({
          connection,
          walletAddress: '${wallet}',
          mint: '${mint}',
          tradeId: 'portfolio-child-trade-' + process.argv[1],
          amountLamports: '60000000',
          maxPortfolioSol: 0.1,
          maxOpenPositions: 5,
        });
        process.stdout.write('reserved');
      } catch (error) {
        process.stdout.write('blocked:' + error.message);
      }
    `;
    const run = suffix => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, suffix], {
        cwd: process.cwd(),
        env: { ...process.env, GMGN_PORTFOLIO_LEDGER_PATH: database, GMGN_PORTFOLIO_LEGACY_PATH: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${code}`)));
    });
    const outcomes = await Promise.all([run('one'), run('two')]);
    assert.equal(outcomes.filter(outcome => outcome === 'reserved').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.startsWith('blocked:Portfolio cap exceeded')).length, 1);
    assert.equal(fs.statSync(database).mode & 0o777, 0o600);
  });
});

test('migrates legacy JSON reservations once without deleting the source file', async t => {
  await isolatedLedger(t, async () => {
    const legacyPath = path.join(path.dirname(process.env.GMGN_PORTFOLIO_LEDGER_PATH), 'legacy.json');
    const oldLegacyPath = process.env.GMGN_PORTFOLIO_LEGACY_PATH;
    process.env.GMGN_PORTFOLIO_LEGACY_PATH = legacyPath;
    t.after(() => {
      if (oldLegacyPath === undefined) delete process.env.GMGN_PORTFOLIO_LEGACY_PATH;
      else process.env.GMGN_PORTFOLIO_LEGACY_PATH = oldLegacyPath;
    });
    const legacy = {
      reservations: [{
        tradeId: 'portfolio-legacy-trade-1',
        walletAddress: wallet,
        mint,
        amountLamports: '25000000',
        createdAt: Date.now(),
      }],
    };
    fs.writeFileSync(legacyPath, JSON.stringify(legacy));
    const snapshot = await getPortfolioSnapshot({ connection: connection(), walletAddress: wallet });
    assert.equal(snapshot.reservedExposureLamports, '25000000');
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyPath, 'utf8')), legacy);
    assert.equal((await getPortfolioSnapshot({ connection: connection(), walletAddress: wallet })).reservedExposureLamports, '25000000');
  });
});

test('corrupt SQLite state fails closed instead of resetting reserved capacity', async t => {
  await isolatedLedger(t, async () => {
    const database = process.env.GMGN_PORTFOLIO_LEDGER_PATH;
    fs.writeFileSync(database, 'not a SQLite database');
    await assert.rejects(getPortfolioSnapshot({ connection: connection(), walletAddress: wallet }));
    assert.equal(fs.readFileSync(database, 'utf8'), 'not a SQLite database');
  });
});

test('fresh chain holdings use minimum-output SOL valuation and stale data blocks', async t => {
  await isolatedLedger(t, async () => {
    t.mock.method(globalThis, 'fetch', async raw => {
      const url = new URL(raw);
      assert.equal(url.hostname, 'lite-api.jup.ag');
      return Response.json({
        inputMint: mint,
        outputMint: 'So11111111111111111111111111111111111111112',
        inAmount: url.searchParams.get('amount'),
        outAmount: '20202021',
        otherAmountThreshold: '20000000',
        swapMode: 'ExactIn',
        slippageBps: 100,
        priceImpactPct: '0.001',
        routePlan: [{}],
        contextSlot: 100,
      });
    });
    const snapshot = await getPortfolioSnapshot({ connection: connection({ amount: '1000000' }), walletAddress: wallet });
    assert.equal(snapshot.currentExposureLamports, '20000000');
    assert.equal(snapshot.valuation, 'sum of fresh Jupiter ExactIn minimum-output SOL quotes for all positive SPL and Token-2022 balances');
    await assert.rejects(reservePortfolioBuy({
      connection: connection({ amount: '1000000' }),
      walletAddress: wallet,
      mint: 'So11111111111111111111111111111111111111112',
      tradeId: 'portfolio-trade-valued-1',
      amountLamports: '81000000',
      maxPortfolioSol: 0.1,
      maxOpenPositions: 5,
    }), /Portfolio cap exceeded/);
    await assert.rejects(getPortfolioSnapshot({ connection: connection({ slot: 0 }), walletAddress: wallet }), /context slot/);
  });
});

test('wallet mint balance is read once and unavailable chain data fails closed', async t => {
  await isolatedLedger(t, async () => {
    const balance = await getWalletMintBalance({ connection: connection({ amount: '1234' }), walletAddress: wallet, mint });
    assert.equal(balance.amountAtomic, '1234');
    await assert.rejects(getWalletMintBalance({
      connection: connection({ slot: 0, amount: '1234' }),
      walletAddress: wallet,
      mint,
    }), /stale or unavailable/);
  });
});
