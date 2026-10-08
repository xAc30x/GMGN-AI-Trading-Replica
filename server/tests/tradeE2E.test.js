import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import bs58 from 'bs58';
import { createSignedInSession } from './authSession.js';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const wallet = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();
const calls = [];
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-e2e-ledger-'));

const fixture = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/rpc') {
    const call = JSON.parse(raw);
    calls.push(call.method);
    if (call.method === 'getAccountInfo') {
      return send({ jsonrpc: '2.0', id: call.id, result: { context: { slot: 1 }, value: {
        data: { program: 'spl-token', parsed: { type: 'mint', info: {
          decimals: 6, supply: '1000000', mintAuthority: null, freezeAuthority: null,
        } }, space: 82 },
        executable: false,
        lamports: 1,
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        rentEpoch: 0,
      } } });
    }
    if (call.method === 'getTokenAccountsByOwner') {
      return send({ jsonrpc: '2.0', id: call.id, result: { context: { slot: 1 }, value: [] } });
    }
    if (call.method === 'getSlot' || call.method === 'getBlockHeight') {
      return send({ jsonrpc: '2.0', id: call.id, result: 1 });
    }
    if (call.method === 'sendTransaction') {
      const transaction = VersionedTransaction.deserialize(Buffer.from(call.params[0], 'base64'));
      return send({ jsonrpc: '2.0', id: call.id, result: bs58.encode(transaction.signatures[0]) });
    }
    if (call.method === 'getSignatureStatuses') {
      return send({ jsonrpc: '2.0', id: call.id, result: {
        context: { slot: 2 },
        value: [{ err: null, confirmationStatus: 'confirmed', slot: 2, confirmations: null }],
      } });
    }
    return send({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: call.method } });
  }

  if (url.pathname === '/jupiter/swap/v1/quote') {
    const query = url.searchParams;
    return send({
      inputMint: query.get('inputMint'),
      outputMint: query.get('outputMint'),
      inAmount: query.get('amount'),
      outAmount: '10000',
      otherAmountThreshold: '9900',
      swapMode: 'ExactIn',
      slippageBps: Number(query.get('slippageBps')),
      priceImpactPct: '0.001',
      routePlan: [{}],
    });
  }
  if (url.pathname === '/jupiter/swap/v1/swap') {
    const body = JSON.parse(raw);
    const message = new TransactionMessage({
      payerKey: new PublicKey(body.userPublicKey),
      recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({
        fromPubkey: new PublicKey(body.userPublicKey),
        toPubkey: recipient,
        lamports: 1,
      })],
    }).compileToV0Message();
    return send({
      swapTransaction: Buffer.from(new VersionedTransaction(message).serialize()).toString('base64'),
      lastValidBlockHeight: 100,
    });
  }
  if (url.pathname === `/rug/v1/tokens/${mint}/report`) {
    return send({ mint, rugged: false, score_normalised: 5, totalMarketLiquidity: 10000,
      markets: [{}], risks: [], topHolders: [{ pct: 0.5 }] });
  }
  if (url.pathname === '/goplus/api/v1/solana/token_security') {
    return send({ code: 1, result: { [mint]: Object.fromEntries(
      ['non_transferable', 'closable', 'transfer_hook', 'freezable', 'mintable']
        .map((key) => [key, { status: '0' }]),
    ) } });
  }
  res.writeHead(404);
  res.end('unexpected fixture path: ' + url.pathname);
});

await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
process.env.SOLANA_RPC_URL = `${fixtureUrl}/rpc`;
process.env.JUPITER_API_BASE = `${fixtureUrl}/jupiter/swap/v1`;
process.env.RUGCHECK_API_BASE = `${fixtureUrl}/rug/v1`;
process.env.GOPLUS_API_BASE = `${fixtureUrl}/goplus/api/v1`;
process.env.GMGN_LIVE = '1';
process.env.GMGN_SOL_BROADCAST = '1';
process.env.GMGN_LOCAL_TOKEN = 'controlled-e2e-token';
process.env.GMGN_TRADE_LEDGER_PATH = path.join(ledgerDir, 'ledger.json');
process.env.GMGN_PORTFOLIO_LEDGER_PATH = path.join(ledgerDir, 'portfolio.sqlite');
process.env.GMGN_LIVE_TRADES_PATH = path.join(ledgerDir, 'live-trades.sqlite');
const session = await createSignedInSession();
const { app } = await import('../index.js');

test('unsigned swap build, local RPC broadcast, and confirmation stay on controlled fixtures', async (t) => {
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => appServer.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => appServer.close(resolve));
    await new Promise((resolve) => fixture.close(resolve));
    fs.rmSync(ledgerDir, { recursive: true, force: true });
    session.cleanup();
  });

  const token = process.env.GMGN_LOCAL_TOKEN;
  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/api/sol/swap-tx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gmgn-token': token, cookie: session.cookie },
    body: JSON.stringify({
      outputMint: mint,
      amount: 0.01,
      slippageBps: 100,
      userPublicKey: wallet.publicKey.toBase58(),
      tradeId: 'controlled-e2e-trade-id-1',
      portfolio: { currentExposureSol: 0, openPositions: 0, isExistingMint: false },
      confirm: true,
      mode: 'LIVE',
    }),
  });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const built = await response.json();
  assert.equal(built.outputMint, mint);

  const transaction = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
  transaction.sign([wallet]);
  const connection = new Connection(`http://127.0.0.1:${appServer.address().port}/api/sol/rpc`, {
    commitment: 'confirmed',
    httpHeaders: { 'X-GMGN-Token': token, 'X-GMGN-Trade-Id': 'controlled-e2e-trade-id-1', Cookie: session.cookie },
  });
  const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 0 });
  assert.equal(signature, bs58.encode(transaction.signatures[0]));
  assert.equal(await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 0 }), signature);
  const status = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  assert.equal(status.value[0].confirmationStatus, 'confirmed');
  assert.equal(calls.filter(method => method === 'sendTransaction').length, 1);
  assert.equal(calls.filter(method => method === 'getSignatureStatuses').length, 1);
  assert.ok(calls.includes('getTokenAccountsByOwner'));
  assert.ok(calls.includes('getBlockHeight'));
});