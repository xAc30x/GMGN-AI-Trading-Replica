import assert from 'node:assert/strict';
import { test, expect } from '@playwright/test';
import bs58 from 'bs58';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const wallet = Keypair.generate();
const outputMint = Keypair.generate().publicKey;
const inputMint = new PublicKey('So11111111111111111111111111111111111111112');
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const associatedTokenProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const jupiterProgram = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const mintText = outputMint.toBase58();
const walletText = wallet.publicKey.toBase58();
const base64 = buffer => Buffer.from(buffer).toString('base64');

function associatedTokenAddress(owner, mint, program) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), program.toBuffer(), mint.toBuffer()],
    associatedTokenProgram,
  )[0];
}

function unsignedSwap({ unsafe = false } = {}) {
  let instructions;
  if (unsafe) {
    instructions = [SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    })];
  } else {
    const data = Buffer.alloc(35);
    Buffer.from([0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a]).copy(data);
    data.writeUInt32LE(1, 8);
    data[12] = 0;
    data[13] = 100;
    data[14] = 0;
    data[15] = 1;
    data.writeBigUInt64LE(10_000_000n, 16);
    data.writeBigUInt64LE(10n, 24);
    data.writeUInt16LE(100, 32);
    data[34] = 0;
    instructions = [new TransactionInstruction({
      programId: jupiterProgram,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: associatedTokenAddress(wallet.publicKey, inputMint, tokenProgram), isSigner: false, isWritable: true },
        { pubkey: associatedTokenAddress(wallet.publicKey, outputMint, tokenProgram), isSigner: false, isWritable: true },
        { pubkey: inputMint, isSigner: false, isWritable: false },
        { pubkey: outputMint, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
      ],
      data,
    })];
  }
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions,
  }).compileToV0Message());
  return base64(transaction.serialize());
}

async function installWallet(page) {
  const bytes = Array.from(wallet.publicKey.toBytes());
  await page.addInitScript(({ address, publicKeyBytes, mint }) => {
    sessionStorage.setItem('gmgn-local-token', 'browser-fixture-token');
    localStorage.setItem('gmgn.watchlist.v1', JSON.stringify([{ mint, symbol: 'TEST', addedAt: 1 }]));
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
    localStorage.removeItem('gmgn.positions.v1');
    localStorage.removeItem('gmgn.trades.v1');
    window.__walletSignCalls = 0;
    const publicKey = {
      toBytes: () => new Uint8Array(publicKeyBytes),
      toBuffer: () => new Uint8Array(publicKeyBytes),
      toBase58: () => address,
      toString: () => address,
    };
    const provider = {
      isPhantom: true,
      isConnected: false,
      publicKey,
      connect: async function () { this.isConnected = true; return { publicKey }; },
      disconnect: async function () { this.isConnected = false; },
      on: () => undefined,
      off: () => undefined,
      signTransaction: async transaction => {
        window.__walletSignCalls += 1;
        transaction.signatures[0] = new Uint8Array(64).fill(7);
        return transaction;
      },
    };
    Object.defineProperty(window, 'isPhantomInstalled', { value: true });
    window.phantom = { solana: provider };
  }, { address: walletText, publicKeyBytes: bytes, mint: mintText });
}

async function installApiFixtures(page, scenario = {}) {
  const counts = { builds: 0, sends: 0, signatures: 0, paperOpens: 0, paperCloses: 0 };
  let paperPosition = null;
  const researchSettings = { scanning: true, autoPaper: false };
  const paperPortfolio = () => ({
    account: { initial: '1000000000', cash: paperPosition ? '987950720' : '1000000000' },
    model: { latencyMs: 1000, feeLamports: '10000', entryRentLamports: '2039280', stopLossPct: -20, takeProfitPct: 30, maxHoldMs: 3600000 },
    positions: paperPosition ? [paperPosition] : [],
    stats: { open: paperPosition?.state === 'open' ? 1 : 0, closed: paperPosition?.state === 'closed' ? 1 : 0, wins: 0,
      realisedPnlLamports: paperPosition?.realisedPnlLamports || '0', equityLamports: null, netPnlLamports: null },
    workerError: null, monitoringEnabled: true, at: Date.now(),
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {};
    try { body = route.request().postDataJSON(); } catch { /* GET request */ }
    if (url.pathname === '/api/research/automation') {
      if (route.request().method() === 'POST') Object.assign(researchSettings, body);
      return route.fulfill({ json: {
        settings: researchSettings, serviceEnabled: true, schedulerError: null, intervalMs: 120000, at: Date.now(),
        policy: { amountSol: 0.01, maxPositions: 3, cooldownMs: 86400000 },
        jobs: [{ source: 'trending', next_at: Date.now() + 120000, lease_until: 0, last_at: Date.now(), failures: 0, last_error: null }],
        accounts: ['momentum-quality-v1', 'safety-feed-v1'].map(id => ({ id, startedAt: Date.now(),
          portfolio: { ...paperPortfolio(), positions: [], stats: { ...paperPortfolio().stats, open: 0, closed: 0, realisedPnlLamports: '0', netPnlLamports: '0' } },
          decisionCounts: [], metrics: { closed: 0, wins: 0, netExpectancySol: null, profitFactor: null, noLosingTrades: false,
            maxObservedDrawdownPct: null, missingEquitySamples: 0, evaluation: 'Insufficient sample' } })), decisions: [],
      } });
    }
    if (url.pathname === '/api/paper/portfolio' || url.pathname === '/api/paper/refresh') return route.fulfill({ json: paperPortfolio() });
    if (url.pathname === '/api/research/scans') return route.fulfill({ json: { totals: { observations: 1, eligible: 0, blocked: 1 }, outcomeCounts: [], rows: [{
      id: 'observation-1', scanId: 'scan-1', at: Date.now(), mint: mintText, symbol: 'REJECTED', decision: 'blocked', source: 'new',
      safety: { blockers: ['Insufficient liquidity'] }, priceUsd: 1,
      outcomes: [{ horizon: 300000, status: 'observed', returnPct: -50, error: null }, { horizon: 3600000, status: 'pending', returnPct: null }, { horizon: 86400000, status: 'pending', returnPct: null }],
    }] } });
    if (url.pathname === '/api/paper/open') {
      counts.paperOpens++;
      paperPosition = { id: body.id, mint: body.mint, symbol: body.symbol, state: 'open', openedAt: Date.now(),
        costLamports: '12049280', quantityAtomic: '9', mark: null, exitPending: null, lastError: null };
      return route.fulfill({ json: { position: paperPosition } });
    }
    if (url.pathname === '/api/paper/close') {
      counts.paperCloses++;
      paperPosition = { ...paperPosition, state: 'closed', exitReason: 'manual', realisedPnlLamports: '-2559280' };
      return route.fulfill({ json: { position: paperPosition } });
    }
    if (url.pathname === '/api/health') {
      return route.fulfill({ json: {
        ok: true,
        cliInstalled: false,
        liveEnabled: true,
        solLiveEnabled: true,
        solBroadcastEnabled: scenario.broadcast ?? true,
        solWalletTrading: true,
        liveReady: true,
        rpcIsPublic: false,
        maxNativeAmount: 0.05,
        maxSlippageBps: 300,
        defaultSlippageBps: 100,
        serverSigningDisabled: true,
        credentials: { apiKey: false, privateKey: false, wallet: false },
      } });
    }
    if (url.pathname === '/api/sol/discover') {
      const base = { mint: mintText, symbol: 'FOUND', name: 'Found token', priceUsd: 2, liquidityUsd: 10000,
        volume24hUsd: 1000, change1hPct: null, change24hPct: 2, marketCapUsd: 100000, buys1h: 2, sells1h: 1, ageMinutes: 5 };
      return route.fulfill({ json: { ok: true, source: url.searchParams.get('source'), minLiquidityUsd: 1000,
        tokens: scenario.discovery ? [
          { ...base, safety: { ok: true, blockers: [], warnings: [], score: 5 }, ranking: { version: 'momentum-quality-v1', action: 'watch', score: 20, reasons: ['Insufficient activity'] } },
          { ...base, mint: inputMint.toBase58(), symbol: 'BLOCKEDTOKEN', safety: { ok: false, blockers: ['Provider unavailable'], warnings: [], score: null } },
        ] : [], at: new Date().toISOString() } });
    }
    if (url.pathname === '/api/sol/position-values') {
      return route.fulfill({ json: { ok: true, results: body.items.map(item => ({ ...item, ok: true,
        outLamports: '20000000', priceImpactPct: '0.001', quotedAt: Date.now(), stale: Boolean(scenario.stale) })), at: Date.now() } });
    }
    if (url.pathname === '/api/sol/prices') {
      return route.fulfill({ json: { ok: true, prices: { [mintText]: 0.002 }, solUsd: 100, at: Date.now() } });
    }
    if (url.pathname === '/api/sol/watchlist-scan') {
      return route.fulfill({ json: { ok: true, scannedAt: new Date().toISOString(), results: [{
        mint: mintText,
        ok: true,
        blockers: [],
        checks: [],
        mintAuthority: null,
        freezeAuthority: null,
        rug: { ok: true, rugcheck: { scoreNormalised: 5, totalMarketLiquidity: 10000 } },
      }] } });
    }
    if (url.pathname === '/api/sol/mint-safety') {
      return route.fulfill({ json: {
        ok: true, mint: mintText, checks: [], blockers: [], mintAuthority: null, freezeAuthority: null,
      } });
    }
    if (url.pathname === '/api/sol/quote') {
      return route.fulfill({ json: {
        ok: true, outputMint: mintText, amountLamports: '10000000', slippageBps: 100,
        outAmount: '10', otherAmountThreshold: '9', priceImpactPct: '0.001', quote: {},
      } });
    }
    if (url.pathname === '/api/sol/swap-tx') {
      counts.builds += 1;
      if (scenario.limit) {
        return route.fulfill({ status: 400, json: { ok: false, error: 'Portfolio cap exceeded: 0.1 SOL' } });
      }
      return route.fulfill({ json: {
        ok: true,
        side: 'buy',
        swapTransaction: unsignedSwap({ unsafe: scenario.unsafe }),
        lastValidBlockHeight: 100,
        inAmount: '10000000',
        outAmount: '10',
        otherAmountThreshold: '9',
        slippageBps: 100,
        inputMint: inputMint.toBase58(),
        outputMint: mintText,
      } });
    }
    if (url.pathname === '/api/sol/rpc') {
      const rpc = body;
      if (rpc.method === 'getTokenAccountsByOwner') {
        return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { context: { slot: 11 },
          value: scenario.zeroBalance ? [] : [{ pubkey: mintText, account: {
            executable: false, lamports: 1, owner: tokenProgram.toBase58(), rentEpoch: 0,
            data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: {
              owner: walletText, mint: mintText, tokenAmount: { amount: '10', decimals: 0, uiAmount: 10 },
            } } },
          } }],
        } } });
      }
      if (rpc.method === 'getAccountInfo') {
        return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: {
          context: { slot: 10 },
          value: { data: ['', 'base64'], executable: false, lamports: 1, owner: tokenProgram.toBase58(), rentEpoch: 0 },
        } } });
      }
      if (rpc.method === 'getFeeForMessage') {
        return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { context: { slot: 10 }, value: 5000 } } });
      }
      if (rpc.method === 'sendTransaction') {
        counts.sends += 1;
        if (scenario.uncertain) {
          scenario.uncertain = false;
          return route.fulfill({ status: 502, json: { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'fixture response lost after dispatch' } } });
        }
        const transaction = VersionedTransaction.deserialize(Buffer.from(rpc.params[0], 'base64'));
        return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: bs58.encode(transaction.signatures[0]) } });
      }
      if (rpc.method === 'getSignatureStatuses') {
        counts.signatures += 1;
        return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: {
          context: { slot: 11 },
          value: [{ err: null, confirmationStatus: 'confirmed', slot: 11, confirmations: null }],
        } } });
      }
      if (rpc.method === 'getSlot' || rpc.method === 'getBlockHeight') {
        return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: 11 } });
      }
      return route.fulfill({ status: 400, json: { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: rpc.method } } });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: `Unexpected fixture path: ${url.pathname}` } });
  });
  return counts;
}

async function unlockLive(page) {
  await page.getByRole('group', { name: 'Trading mode' }).getByRole('button', { name: /LIVE/ }).click();
  const unlock = page.getByRole('dialog', { name: 'Unlock LIVE trading' });
  await expect(unlock).toBeVisible();
  await unlock.getByLabel(/to confirm/).fill('live');
  await unlock.getByRole('button', { name: 'Unlock LIVE for 30 min' }).click();
  await expect(unlock).toHaveCount(0);
}

async function openLiveTrade(page, openBuy = true) {
  await installWallet(page);
  await page.goto('/');
  await expect(page.locator('.wallet-adapter-button')).toContainText(walletText.slice(0, 4), { timeout: 15_000 });
  page.on('dialog', dialog => dialog.accept());
  const modes = page.getByRole('group', { name: 'Trading mode' });
  await modes.getByRole('button', { name: 'PAPER' }).click();
  await expect(modes.getByRole('button', { name: 'PAPER' })).toHaveAttribute('aria-pressed', 'true');
  await unlockLive(page);
  await expect(modes.getByRole('button', { name: 'LIVE' })).toHaveAttribute('aria-pressed', 'true');
  if (!openBuy) return;
  await page.getByRole('button', { name: /BUY 0.01 SOL/ }).click();
  await expect(page.getByRole('dialog', { name: /One-Click Buy/ })).toBeVisible();
  await page.getByRole('checkbox', { name: /I understand my wallet will spend real SOL/ }).check({ force: true });
  await expect(page.getByRole('button', { name: 'Sign SOL swap in wallet' })).toBeEnabled({ timeout: 10_000 });
}

test('successfully signs and confirms an independently validated local swap; recent duplicate is blocked', async ({ page }) => {
  const counts = await installApiFixtures(page);
  await openLiveTrade(page);
  await page.getByRole('button', { name: 'Sign SOL swap in wallet' }).click();
  await expect(page.getByText(/Confirmed:/)).toBeVisible({ timeout: 10_000 });
  assert.equal(await page.evaluate(() => window.__walletSignCalls), 1);
  assert.equal(counts.builds, 1);
  assert.equal(counts.sends, 1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('gmgn.trades.v1') || '[]')[0]?.status)).toBe('confirmed');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('gmgn.positions.v1') || '[]').length)).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5_000 });
  await page.getByRole('button', { name: /BUY 0.01 SOL/ }).click();
  await page.getByRole('checkbox', { name: /I understand my wallet will spend real SOL/ }).check({ force: true });
  await expect(page.getByRole('button', { name: 'Sign SOL swap in wallet' })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Sign SOL swap in wallet' }).click();
  await expect(page.getByText(/Matching trade already has signature|already in progress/)).toBeVisible();
  assert.equal(counts.builds, 1);
  assert.equal(await page.evaluate(() => window.__walletSignCalls), 1);
});

test('rejects an unsafe unsigned transfer before requesting wallet approval', async ({ page }) => {
  const counts = await installApiFixtures(page, { unsafe: true });
  await openLiveTrade(page);
  await page.getByRole('button', { name: 'Sign SOL swap in wallet' }).click();
  await expect(page.getByText(/Unsafe swap transaction: unexpected system transfer/)).toBeVisible({ timeout: 10_000 });
  assert.equal(await page.evaluate(() => window.__walletSignCalls), 0);
  assert.equal(counts.builds, 1);
  assert.equal(counts.sends, 0);
});

test('server portfolio cap rejection never reaches wallet signing', async ({ page }) => {
  const counts = await installApiFixtures(page, { limit: true });
  await openLiveTrade(page);
  await page.getByRole('button', { name: 'Sign SOL swap in wallet' }).click();
  await expect(page.getByText(/Portfolio cap exceeded/)).toBeVisible({ timeout: 10_000 });
  assert.equal(await page.evaluate(() => window.__walletSignCalls), 0);
  assert.equal(counts.builds, 1);
  assert.equal(counts.sends, 0);
});

test('uncertain send reconciles by signature and prevents a duplicate submission', async ({ page }) => {
  const counts = await installApiFixtures(page, { uncertain: true });
  await openLiveTrade(page);
  await page.getByRole('button', { name: 'Sign SOL swap in wallet' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('gmgn.trades.v1') || '[]')[0]?.status)).toBe('confirmed');
  assert.equal(counts.sends, 1);
  assert.ok(counts.signatures >= 1);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gmgn.positions.v1') || '[]').length), 1);
  await page.getByRole('button', { name: 'Sign SOL swap in wallet' }).click();
  await expect(page.getByText(/Matching trade already has signature/)).toBeVisible();
  assert.equal(counts.builds, 1);
  assert.equal(counts.sends, 1);
  assert.equal(await page.evaluate(() => window.__walletSignCalls), 1);
});


test('discovery screens tokens, adds a watch entry and opens the existing guarded buy flow', async ({ page }) => {
  const counts = await installApiFixtures(page, { discovery: true });
  await openLiveTrade(page, false);
  const discovery = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Discover · LIVE' }) });
  await expect(discovery.getByText('FOUND', { exact: true })).toBeVisible();
  const blocked = discovery.getByRole('row').filter({ hasText: 'BLOCKEDTOKEN' });
  await expect(blocked.getByRole('button', { name: /BUY/ })).toHaveCount(0);
  const found = discovery.getByRole('row').filter({ hasText: 'FOUND' });
  await found.getByRole('button', { name: '+ Watch' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('gmgn.watchlist.v1'))[0].symbol)).toBe('FOUND');
  await found.getByRole('button', { name: /BUY/ }).click();
  await expect(page.getByRole('dialog', { name: /One-Click Buy/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign SOL swap in wallet' })).toBeDisabled();
  assert.equal(counts.builds, 0);
  assert.equal(await page.evaluate(() => window.__walletSignCalls), 0);
});

test('holdings show cached valuation and hide zero balances without deleting trade history', async ({ page }) => {
  await page.clock.install();
  const scenario = { stale: true, zeroBalance: false };
  const counts = await installApiFixtures(page, scenario);
  await openLiveTrade(page);
  await page.getByRole('button', { name: 'Sign SOL swap in wallet' }).click();
  const holdings = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Tracked holdings' }) });
  await expect(holdings.getByText('+100.00% · 0.02000 SOL · cached quote')).toBeVisible();
  const positions = await page.evaluate(() => localStorage.getItem('gmgn.positions.v1'));
  const journal = await page.evaluate(() => localStorage.getItem('gmgn.trades.v1'));
  scenario.zeroBalance = true;
  await page.clock.runFor(16000);
  await expect(holdings.getByText('No balance · checking')).toBeVisible();
  await page.clock.runFor(16000);
  await expect(holdings.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate(() => localStorage.getItem('gmgn.positions.v1')), positions);
  assert.equal(await page.evaluate(() => localStorage.getItem('gmgn.trades.v1')), journal);
  assert.equal(counts.sends, 1);
});


test('paper positions open without a wallet, survive reload, and close without building or signing transactions', async ({ page }) => {
  const counts = await installApiFixtures(page, { discovery: true });
  await page.addInitScript(() => { sessionStorage.setItem('gmgn-local-token', 'browser-fixture-token'); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  await page.getByRole('group', { name: 'Trading mode' }).getByRole('button', { name: 'PAPER' }).click();
  await expect(page.getByRole('group', { name: 'Trading mode' }).getByRole('button', { name: 'PAPER' })).toHaveAttribute('aria-pressed', 'true');
  const discovery = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Discover · PAPER' }) });
  await discovery.getByRole('row').filter({ hasText: 'FOUND' }).getByRole('button', { name: /BUY/ }).click();
  await page.getByRole('checkbox', { name: /I understand PAPER/ }).check({ force: true });
  await page.getByRole('button', { name: 'Open paper position', exact: true }).click();
  const research = page.locator('.research-panel').filter({ has: page.getByRole('heading', { name: 'Paper portfolio & scan history', exact: true }) });
  await expect(research.getByRole('button', { name: 'Close paper' })).toBeVisible();
  await expect(research.getByText('0.012049 SOL', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('group', { name: 'Trading mode' }).getByRole('button', { name: 'PAPER' }).click();
  await expect(research.getByRole('button', { name: 'Close paper' })).toBeVisible();
  await research.getByRole('button', { name: 'Close paper' }).click();
  await expect(research.getByText('manual', { exact: true })).toBeVisible();
  await expect(research.getByText('-0.002559 SOL', { exact: true }).last()).toBeVisible();
  await research.locator('summary').click();
  await expect(research.getByRole('cell', { name: 'REJECTED Latest profiles', exact: true })).toBeVisible();
  await expect(research.getByText('-50.00%', { exact: true })).toBeVisible();
  await research.screenshot({ path: '/tmp/gmgn-paper-research.png' });
  assert.equal(counts.paperOpens, 1); assert.equal(counts.paperCloses, 1);
  assert.equal(counts.builds, 0); assert.equal(counts.sends, 0);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gmgn.trades.v1') || '[]').length), 0);
});


test('research controls persist pauses and clearly separate virtual comparison from live execution', async ({ page }) => {
  const counts = await installApiFixtures(page, { discovery: true });
  await page.addInitScript(() => { sessionStorage.setItem('gmgn-local-token', 'browser-fixture-token'); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/'); await page.getByRole('group', { name: 'Trading mode' }).getByRole('button', { name: 'PAPER' }).click();
  const panel = page.getByRole('region', { name: 'Research automation', exact: true });
  await expect(panel.getByText('Scans: running · Automatic paper entries: paused', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Start paper comparison', exact: true }).click();
  await expect(panel.getByText('Scans: running · Automatic paper entries: running', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Pause automatic paper entries' }).click();
  await expect(panel.getByText('Scans: running · Automatic paper entries: paused', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Pause background scans' }).click();
  await expect(panel.getByRole('button', { name: 'Start paper comparison' })).toBeDisabled();
  await page.reload(); await page.getByRole('group', { name: 'Trading mode' }).getByRole('button', { name: 'PAPER' }).click();
  await expect(panel.getByRole('button', { name: 'Resume background scans' })).toBeVisible();
  await expect(panel.getByText('Scans: paused · Automatic paper entries: paused', { exact: true })).toBeVisible();
  await expect(panel.getByRole('cell', { name: /momentum-quality-v1/ })).toBeVisible();
  await expect(panel.getByRole('cell', { name: /safety-feed-v1/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /^watch · 20\/100/ })).toBeVisible();
  await panel.screenshot({ path: '/tmp/gmgn-automation-panel.png' });
  assert.equal(counts.builds, 0); assert.equal(counts.sends, 0); assert.equal(counts.paperOpens, 0);
});

test('mode banner always states the active mode and what it can do', async ({ page }) => {
  await installApiFixtures(page, { discovery: true });
  await page.addInitScript(() => { sessionStorage.setItem('gmgn-local-token', 'browser-fixture-token'); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  const banner = page.getByRole('status', { name: 'Trading mode SHADOW' });
  await expect(banner).toContainText('nothing touches a chain');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-mode', 'SHADOW');
  await page.getByRole('group', { name: 'Trading mode' }).getByRole('button', { name: 'PAPER' }).click();
  await expect(page.getByRole('status', { name: 'Trading mode PAPER' })).toContainText('nothing is signed or broadcast');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-mode', 'PAPER');
});

test('header reports the RPC type from server status and offers one mode switch', async ({ page }) => {
  await installApiFixtures(page);
  await page.goto('/');
  const header = page.locator('header');
  await expect(header.getByText('DEDICATED RPC', { exact: true })).toBeVisible();
  await expect(header.getByText(/LAT \d+ms/)).toHaveCount(0);
  const modes = page.getByRole('group', { name: 'Trading mode' });
  await expect(modes.getByRole('button')).toHaveText(['SHADOW', 'PAPER', 'LIVE ⊘']);
  await expect(modes.getByRole('button', { name: 'SHADOW' })).toHaveAttribute('aria-pressed', 'true');
});

test('LIVE needs typed confirmation, blocks on a failed preflight and can be cancelled', async ({ page }) => {
  await installWallet(page);
  await installApiFixtures(page, { broadcast: false });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  await expect(page.locator('.wallet-adapter-button')).toContainText(walletText.slice(0, 4), { timeout: 15_000 });
  const modes = page.getByRole('group', { name: 'Trading mode' });
  await modes.getByRole('button', { name: /LIVE/ }).click();
  const unlock = page.getByRole('dialog', { name: 'Unlock LIVE trading' });
  const checks = unlock.getByRole('list', { name: 'Preflight checks' });
  await expect(checks.getByRole('listitem').filter({ hasText: 'GMGN_SOL_BROADCAST' })).toContainText('unset · no sends');
  await expect(checks.getByRole('listitem').filter({ hasText: 'Wallet connected' })).toContainText('Phantom');
  await unlock.getByLabel(/to confirm/).fill('LIVE');
  await expect(unlock.getByRole('button', { name: /Blocked · 1 preflight check failed/ })).toBeDisabled();
  await unlock.getByRole('button', { name: /Stay in SHADOW/ }).click();
  await expect(modes.getByRole('button', { name: 'SHADOW' })).toHaveAttribute('aria-pressed', 'true');
});

test('LIVE unlock is time-boxed and Lock now returns to PAPER', async ({ page }) => {
  await installWallet(page);
  await installApiFixtures(page);
  page.on('dialog', dialog => dialog.accept());
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.wallet-adapter-button')).toContainText(walletText.slice(0, 4), { timeout: 15_000 });
  const modes = page.getByRole('group', { name: 'Trading mode' });
  await modes.getByRole('button', { name: /LIVE/ }).click();
  const unlock = page.getByRole('dialog', { name: 'Unlock LIVE trading' });
  await expect(unlock.getByRole('button', { name: 'Type LIVE to unlock' })).toBeDisabled();
  await unlock.getByRole('button', { name: '15 min' }).click();
  await unlock.getByLabel(/to confirm/).fill('LIVE');
  await unlock.getByRole('button', { name: 'Unlock LIVE for 15 min' }).click();
  await expect(page.getByRole('status', { name: 'Trading mode LIVE' })).toContainText('auto-locks in 15:00');
  await page.clock.fastForward('15:01');
  await expect(modes.getByRole('button', { name: 'PAPER' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('LIVE session ended — switched back to PAPER')).toBeVisible();

  await modes.getByRole('button', { name: /LIVE/ }).click();
  await expect(unlock.getByLabel(/to confirm/)).toHaveValue('');
  await unlock.getByLabel(/to confirm/).fill('LIVE');
  // The dialog remembers the last session length but never the typed confirmation.
  await unlock.getByRole('button', { name: 'Unlock LIVE for 15 min' }).click();
  await page.getByRole('button', { name: 'LOCK NOW' }).click();
  await expect(modes.getByRole('button', { name: 'PAPER' })).toHaveAttribute('aria-pressed', 'true');
});
