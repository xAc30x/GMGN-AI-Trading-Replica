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
  const counts = { builds: 0, sends: 0, signatures: 0 };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {};
    try { body = route.request().postDataJSON(); } catch { /* GET request */ }
    if (url.pathname === '/api/health') {
      return route.fulfill({ json: {
        ok: true,
        cliInstalled: false,
        liveEnabled: true,
        solLiveEnabled: true,
        solBroadcastEnabled: true,
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

async function openLiveTrade(page) {
  await installWallet(page);
  await page.goto('/');
  await expect(page.locator('.wallet-adapter-button')).toContainText(walletText.slice(0, 4), { timeout: 15_000 });
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /MODE SHADOW/ }).click();
  await expect(page.getByRole('button', { name: /MODE PAPER/ })).toBeVisible();
  await page.getByRole('button', { name: /MODE PAPER/ }).click();
  await expect(page.getByRole('button', { name: /MODE LIVE/ })).toBeVisible();
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
