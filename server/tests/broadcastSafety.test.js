import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import bs58 from 'bs58';
import { createSignedInSession } from './authSession.js';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

// These are acceptance tests, not expected-failure snapshots. On an unsafe
// baseline they MUST fail, including under the normal `npm test` command.
// No real wallets, providers, signing credentials, or persisted runtime data.
const TOKEN = 'broadcast-safety-fixture-token';
const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SPL = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const JUPITER = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const associated = (owner, mint) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), SPL.toBuffer(), new PublicKey(mint).toBuffer()], ATA,
)[0];

// Deliberately synthetic, matching the existing transactionPolicy fixtures.
// It tests server-build/message binding; it does NOT prove chain executability
// or conformance to every Jupiter account schema or instruction variant.
function unsignedFixture(owner, quote) {
  const data = Buffer.alloc(35);
  Buffer.from([0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a]).copy(data);
  data.writeUInt32LE(1, 8);
  data[13] = 100;
  data[15] = 1;
  data.writeBigUInt64LE(BigInt(quote.inAmount), 16);
  data.writeBigUInt64LE(BigInt(quote.outAmount), 24);
  data.writeUInt16LE(quote.slippageBps, 32);
  const keys = [owner, associated(owner, quote.inputMint), associated(owner, quote.outputMint),
    new PublicKey(quote.inputMint), new PublicKey(quote.outputMint), SPL]
    .map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: index < 3 }));
  return new VersionedTransaction(new TransactionMessage({
    payerKey: owner,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [new TransactionInstruction({ programId: JUPITER, keys, data })],
  }).compileToV0Message());
}

const encode = tx => Buffer.from(tx.serialize()).toString('base64');
const decode = text => VersionedTransaction.deserialize(Buffer.from(text, 'base64'));
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const close = server => new Promise(resolve => {
  if (!server?.listening) return resolve();
  server.close(resolve);
  server.closeAllConnections();
});

describe('broadcast-boundary safety acceptance — isolated fixtures only', { concurrency: false }, () => {
  let directory, fixture, application, session, wallet, tradeId, sequence = 0;
  let blockHeight = 1, responseKind = 'normal', heldAmount = '10000';
  let sends = [], fixtureErrors = [], deniedConnections = [], loseNextResponse = false;
  const savedEnv = new Map();
  const allowedPorts = new Set();
  function setEnv(key, value) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-broadcast-safety-'));
    // Guard below both fetch implementations (global fetch and web3's transport).
    // Only these two ephemeral loopback servers can receive socket connections.
    const connect = net.Socket.prototype.connect;
    mock.method(net.Socket.prototype, 'connect', function (...args) {
      const normalized = Array.isArray(args[0]) ? args[0] : args;
      const options = typeof normalized[0] === 'object'
        ? normalized[0] : { port: normalized[0], host: normalized[1] };
      if (options?.host !== '127.0.0.1' || !allowedPorts.has(Number(options.port))) {
        const target = `${options?.host}:${options?.port}`;
        deniedConnections.push(target);
        throw new Error(`Fixture blocked non-fixture network connection: ${target}`);
      }
      return connect.apply(this, args);
    });

    fixture = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString();
        const url = new URL(req.url, 'http://127.0.0.1');
        const send = body => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (url.pathname === '/rpc') {
          const rpc = JSON.parse(raw);
          let result;
          if (rpc.method === 'sendTransaction') {
            const tx = decode(rpc.params[0]);
            sends.push({ signature: bs58.encode(tx.signatures[0]), payload: rpc.params[0], options: rpc.params[1] });
            if (responseKind === 'malformed') { res.end('invalid-json'); return; }
            if (responseKind === 'error') return send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'fixture error' } });
            if (loseNextResponse) { loseNextResponse = false; req.socket.destroy(); return; }
            result = responseKind === 'mismatch' ? bs58.encode(new Uint8Array(64).fill(1)) : bs58.encode(tx.signatures[0]);
          } else if (rpc.method === 'getAccountInfo') {
            result = { context: { slot: 1 }, value: {
              data: { program: 'spl-token', parsed: { type: 'mint', info: {
                decimals: 6, supply: '1000000', mintAuthority: null, freezeAuthority: null,
              } }, space: 82 },
              executable: false, lamports: 1, owner: SPL.toBase58(), rentEpoch: 0,
            } };
          } else if (rpc.method === 'getTokenAccountsByOwner') {
            result = { context: { slot: 1 }, value: rpc.params[1].mint ? [{
              pubkey: SOL, account: { executable: false, lamports: 1, owner: SPL.toBase58(), rentEpoch: 0,
                data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: {
                  mint: MINT, owner: wallet.publicKey.toBase58(),
                  state: 'initialized', isNative: false, tokenAmount: { amount: heldAmount, decimals: 6 },
                } } } },
            }] : [] };
          } else if (rpc.method === 'getLatestBlockhash') {
            result = { context: { slot: 1 }, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 } };
          } else if (rpc.method === 'getSlot') result = 1;
          else if (rpc.method === 'getBlockHeight') result = blockHeight;
          else if (rpc.method === 'getSignatureStatuses') {
            result = { context: { slot: 1 }, value: rpc.params[0].map(() => null) };
          } else if (rpc.method === 'getTransaction') result = null; // This fixture never lands a transaction.
          else throw new Error(`Unexpected fixture RPC method: ${rpc.method}`);
          return send({ jsonrpc: '2.0', id: rpc.id, result });
        }
        if (url.pathname === '/jupiter/quote') {
          const q = url.searchParams;
          return send({ inputMint: q.get('inputMint'), outputMint: q.get('outputMint'),
            inAmount: q.get('amount'), outAmount: '10000', otherAmountThreshold: '9900',
            swapMode: 'ExactIn', slippageBps: Number(q.get('slippageBps')),
            priceImpactPct: '0.001', contextSlot: 1, routePlan: [{}] });
        }
        if (url.pathname === '/jupiter/swap') {
          const body = JSON.parse(raw);
          return send({ swapTransaction: encode(unsignedFixture(new PublicKey(body.userPublicKey), body.quoteResponse)),
            lastValidBlockHeight: 100 });
        }
        if (url.pathname === `/rug/tokens/${MINT}/report`) {
          return send({ mint: MINT, rugged: false, score_normalised: 5, totalMarketLiquidity: 10000,
            markets: [{}], risks: [], topHolders: [{ pct: 0.5 }] });
        }
        if (url.pathname === '/goplus/solana/token_security') {
          return send({ code: 1, result: { [MINT]: Object.fromEntries(
            ['non_transferable', 'closable', 'transfer_hook', 'freezable', 'mintable']
              .map(key => [key, { status: '0' }]),
          ) } });
        }
        throw new Error(`Unexpected fixture path: ${url.pathname}`);
      } catch (error) {
        fixtureErrors.push(error.message);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    await listen(fixture);
    allowedPorts.add(fixture.address().port);
    const base = `http://127.0.0.1:${fixture.address().port}`;
    for (const [key, value] of Object.entries({
      SOLANA_RPC_URL: `${base}/rpc`, VITE_SOLANA_RPC_URL: `${base}/rpc`,
      JUPITER_API_BASE: `${base}/jupiter`, RUGCHECK_API_BASE: `${base}/rug`, GOPLUS_API_BASE: `${base}/goplus`,
      GMGN_LOCAL_TOKEN: TOKEN, GMGN_LIVE: '0', GMGN_SOL_BROADCAST: '0',
      GMGN_MAX_NATIVE_AMOUNT: '0.05', GMGN_MAX_PORTFOLIO_SOL: '0.1', GMGN_MAX_OPEN_POSITIONS: '5',
      GMGN_MAX_SLIPPAGE_BPS: '300', GMGN_MAX_PRICE_IMPACT_PCT: '5', GMGN_MIN_LIQUIDITY_USD: '1000', GMGN_MAX_RUG_SCORE: '40',
      GMGN_RESEARCH_DB_PATH: path.join(directory, 'research.sqlite'),
      GMGN_PORTFOLIO_LEGACY_PATH: path.join(directory, 'no-legacy.json'),
    })) setEnv(key, value);
    // Import does not run the executable startup path or its background workers.
    session = await createSignedInSession();
    const { app } = await import('../index.js');
    application = http.createServer(app);
    await listen(application);
    allowedPorts.add(application.address().port);
  });

  beforeEach(() => {
    // Open the code paths only in this guarded test process, after local setup.
    setEnv('GMGN_LIVE', '1');
    setEnv('GMGN_SOL_BROADCAST', '1');
    const id = ++sequence;
    setEnv('GMGN_TRADE_LEDGER_PATH', path.join(directory, `broadcast-${id}.json`));
    setEnv('GMGN_PORTFOLIO_LEDGER_PATH', path.join(directory, `portfolio-${id}.sqlite`));
    setEnv('GMGN_LIVE_TRADES_PATH', path.join(directory, `live-trades-${id}.sqlite`));
    wallet = Keypair.generate();
    tradeId = `broadcast-safety-${id}-original`;
    sends = [];
    blockHeight = 1;
    heldAmount = '10000';
    responseKind = 'normal';
    loseNextResponse = false;
  });

  after(async () => {
    await close(application);
    await close(fixture);
    session?.cleanup();
    mock.restoreAll();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(fixtureErrors, [], 'Fixture errors must not masquerade as policy rejections');
    assert.deepEqual(deniedConnections, [], 'Application attempted an unexpected network connection');
  });

  function request(route, body, token = TOKEN, id = tradeId) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: application.address().port,
        path: route, method: 'POST', headers: { 'content-type': 'application/json',
          'x-gmgn-token': token, 'x-gmgn-trade-id': id, cookie: session.cookie } }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }
  async function build(mode = 'LIVE', id = tradeId) {
    const result = await request('/api/sol/swap-tx', { outputMint: MINT, amount: 0.01, slippageBps: 100,
      userPublicKey: wallet.publicKey.toBase58(), tradeId: id, confirm: true, mode });
    assert.equal(result.status, 200, `Fixture build failed: ${JSON.stringify(result)}`);
    return result.body;
  }
  function sign(built, mutate = () => {}, signer = wallet) {
    const message = TransactionMessage.decompile(decode(built.swapTransaction).message);
    mutate(message);
    const tx = new VersionedTransaction(message.compileToV0Message());
    tx.sign([signer]);
    return encode(tx);
  }
  const broadcast = (payload, id = tradeId, token = TOKEN) => request('/api/sol/rpc', {
    jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [payload, { encoding: 'base64', skipPreflight: false, maxRetries: 0 }],
  }, token, id);
  function assertRejectedWithoutSend(response, previousSends = 0) {
    assert.deepEqual({ upstreamSends: sends.length - previousSends,
      rejected: response.status >= 400 && response.status < 500 },
    { upstreamSends: 0, rejected: true }, `Unsafe request must be rejected before RPC; response=${JSON.stringify(response)}`);
  }

  test('control: unchanged server build forwards once and same-ID retry is cached', async () => {
    const payload = sign(await build());
    const first = await broadcast(payload);
    assert.equal(first.status, 200);
    assert.equal(first.body.result, bs58.encode(decode(payload).signatures[0]));
    assert.deepEqual(await broadcast(payload), first);
    assert.equal(sends.length, 1);
  });
  test('control: missing authentication rejects without an upstream send', async () => {
    assertRejectedWithoutSend(await broadcast(sign(await build()), tradeId, ''));
  });
  for (const gate of ['GMGN_LIVE', 'GMGN_SOL_BROADCAST']) {
    test(`control: ${gate}=0 rejects without an upstream send`, async () => {
      const payload = sign(await build());
      setEnv(gate, '0');
      assertRejectedWithoutSend(await broadcast(payload));
    });
  }
  test('control: invalid signature rejects without an upstream send', async () => {
    const tx = decode(sign(await build()));
    tx.signatures[0][0] ^= 1;
    assertRejectedWithoutSend(await broadcast(encode(tx)));
  });
  test('control: changed payload under an accepted trade ID rejects without a second send', async () => {
    const built = await build();
    assert.equal((await broadcast(sign(built))).status, 200);
    const changed = sign(built, message => { message.recentBlockhash = Keypair.generate().publicKey.toBase58(); });
    assertRejectedWithoutSend(await broadcast(changed), 1);
  });
  test('control: lost response blocks same-ID retry without a second send', async () => {
    const payload = sign(await build());
    loseNextResponse = true;
    assert.equal((await broadcast(payload)).status, 502);
    assert.equal(sends.length, 1);
    assertRejectedWithoutSend(await broadcast(payload), 1);
  });

  test('rejects a signed transaction with no server-built trade authorization', async () => {
    const tx = unsignedFixture(wallet.publicKey, { inputMint: SOL, outputMint: MINT,
      inAmount: '10000000', outAmount: '10000', slippageBps: 100 });
    tx.sign([wallet]);
    assertRejectedWithoutSend(await broadcast(encode(tx)));
  });
  test('rejects a different signing wallet under an existing trade ID', async () => {
    const built = await build();
    const other = Keypair.generate();
    const changed = sign(built, message => {
      message.payerKey = other.publicKey;
      for (const instruction of message.instructions) {
        for (const key of instruction.keys) {
          if (key.pubkey.equals(wallet.publicKey)) key.pubkey = other.publicKey;
        }
      }
    }, other);
    assertRejectedWithoutSend(await broadcast(changed));
  });
  test('rejects an output mint and destination changed after the server build', async () => {
    const built = await build();
    const otherMint = Keypair.generate().publicKey;
    const changed = sign(built, message => {
      const route = message.instructions[0];
      route.keys[2].pubkey = associated(wallet.publicKey, otherMint);
      route.keys[4].pubkey = otherMint;
    });
    assertRejectedWithoutSend(await broadcast(changed));
  });
  for (const [label, amount] of [['within', 20_000_000n], ['above', 100_000_000n]]) {
    test(`rejects an altered input amount ${label} the configured per-trade cap`, async () => {
      const changed = sign(await build(), message => {
        message.instructions[0].data.writeBigUInt64LE(amount, 16);
      });
      assertRejectedWithoutSend(await broadcast(changed));
    });
  }
  test('rejects swapped source/destination roles even when both accounts are still present', async () => {
    const changed = sign(await build(), message => {
      const keys = message.instructions[0].keys;
      [keys[1], keys[2]] = [keys[2], keys[1]];
    });
    assertRejectedWithoutSend(await broadcast(changed));
  });
  test('rejects an unrelated SOL transfer appended to the server build', async () => {
    const changed = sign(await build(), message => {
      message.instructions.push(SystemProgram.transfer({ fromPubkey: wallet.publicKey,
        toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    });
    assertRejectedWithoutSend(await broadcast(changed));
  });
  test('rejects a signed PAPER build at the real-transaction broadcast boundary', async () => {
    assertRejectedWithoutSend(await broadcast(sign(await build('PAPER'))));
  });
  test('rejects a previously accepted signature replayed under a new trade ID', async () => {
    const payload = sign(await build());
    assert.equal((await broadcast(payload)).status, 200);
    assert.equal(sends.length, 1);
    const replayId = `${tradeId}-replay`;
    await build('LIVE', replayId);
    assertRejectedWithoutSend(await broadcast(payload, replayId), 1);
  });
  test('rejects a signature with a lost response replayed under a new trade ID', async () => {
    const payload = sign(await build());
    loseNextResponse = true;
    assert.equal((await broadcast(payload)).status, 502);
    assert.equal(sends.length, 1);
    const replayId = `${tradeId}-replay`;
    await build('LIVE', replayId);
    assertRejectedWithoutSend(await broadcast(payload, replayId), 1);
  });
  test('an authorized close forwards once and its retry is cached', async () => {
    const built = await request('/api/sol/close-tx', { inputMint: MINT, amountAtomic: '100',
      slippageBps: 100, userPublicKey: wallet.publicKey.toBase58(), tradeId, confirm: true, mode: 'LIVE' });
    assert.equal(built.status, 200, JSON.stringify(built));
    const payload = sign(built.body);
    const first = await broadcast(payload);
    assert.equal(first.status, 200);
    assert.deepEqual(await broadcast(payload), first);
    assert.equal(sends.length, 1);
  });
  test('a changed close message never reaches upstream', async () => {
    const built = await request('/api/sol/close-tx', { inputMint: MINT, amountAtomic: '100',
      slippageBps: 100, userPublicKey: wallet.publicKey.toBase58(), tradeId, confirm: true, mode: 'LIVE' });
    assert.equal(built.status, 200);
    assertRejectedWithoutSend(await broadcast(sign(built.body, message => {
      message.instructions[0].data.writeBigUInt64LE(101n, 16);
    })));
  });
  const reclaim = (body = {}) => request('/api/sol/reclaim-tx', { mint: MINT,
    userPublicKey: wallet.publicKey.toBase58(), tradeId, confirm: true, mode: 'LIVE', ...body });
  test('an authorized reclaim of an empty account forwards once and its retry is cached', async () => {
    heldAmount = '0';
    const built = await reclaim();
    assert.equal(built.status, 200, JSON.stringify(built));
    assert.equal(built.body.refundLamports, '1');
    const payload = sign({ swapTransaction: built.body.transaction });
    const first = await broadcast(payload);
    assert.equal(first.status, 200);
    assert.deepEqual(await broadcast(payload), first);
    assert.equal(sends.length, 1);
  });
  test('a reclaim redirected to another wallet never reaches upstream', async () => {
    heldAmount = '0';
    const built = await reclaim();
    assert.equal(built.status, 200);
    assertRejectedWithoutSend(await broadcast(sign({ swapTransaction: built.body.transaction }, message => {
      message.instructions[0].keys[1].pubkey = Keypair.generate().publicKey;
    })));
  });
  test('a reclaim is refused while the account holds tokens or outside LIVE', async () => {
    assert.equal((await reclaim()).status, 404);
    heldAmount = '0';
    assert.equal((await reclaim({ mode: 'PAPER' })).status, 403);
    assert.equal((await reclaim({ confirm: false })).status, 403);
    setEnv('GMGN_LIVE', '0');
    assert.match((await reclaim()).body.error, /LIVE disabled on server/);
    assert.equal(sends.length, 0);
  });
  test('expired authorization rejects before dispatch', async () => {
    const payload = sign(await build());
    blockHeight = 101;
    assertRejectedWithoutSend(await broadcast(payload));
  });
  test('missing buy reservation rejects even with a valid message authorization', async () => {
    const payload = sign(await build());
    const { releasePortfolioReservation } = await import('../portfolioLedger.js');
    await releasePortfolioReservation(tradeId);
    assertRejectedWithoutSend(await broadcast(payload));
  });
  for (const kind of ['mismatch', 'malformed', 'error']) {
    test(`RPC ${kind} response retains the claim and blocks re-dispatch`, async () => {
      const payload = sign(await build());
      responseKind = kind;
      assert.equal((await broadcast(payload)).status, 502);
      assert.equal(sends.length, 1);
      responseKind = 'normal';
      assertRejectedWithoutSend(await broadcast(payload), 1);
    });
  }
  test('concurrent HTTP submissions dispatch at most once', async () => {
    const payload = sign(await build());
    const responses = await Promise.all(Array.from({ length: 4 }, () => broadcast(payload)));
    assert.ok(responses.some(r => r.status === 200));
    assert.ok(responses.every(r => [200, 409].includes(r.status)));
    assert.equal(sends.length, 1);
  });
  test('caller RPC options cannot bypass preflight or trigger upstream retries', async () => {
    const payload = sign(await build());
    const response = await request('/api/sol/rpc', { jsonrpc: '2.0', id: 1, method: 'sendTransaction',
      params: [payload, { encoding: 'base64', skipPreflight: true, maxRetries: 100 }] });
    assert.equal(response.status, 200);
    assert.deepEqual(sends[0].options, { encoding: 'base64', skipPreflight: false, maxRetries: 0 });
  });
  test('corrupt authorization storage fails closed before dispatch', async () => {
    const payload = sign(await build());
    fs.writeFileSync(`${process.env.GMGN_TRADE_LEDGER_PATH}.sqlite`, 'broken database');
    assert.equal((await broadcast(payload)).status, 503);
    assert.equal(sends.length, 0);
  });

});
