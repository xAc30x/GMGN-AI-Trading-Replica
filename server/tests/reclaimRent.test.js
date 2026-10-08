import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { buildReclaimTransaction, emptyTokenAccounts, TOKEN_PROGRAMS } from '../reclaimRent.js';
import { authorizeBroadcast } from '../tradeLedger.js';

const [SPL, TOKEN_2022] = TOKEN_PROGRAMS;
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const wallet = Keypair.generate().publicKey;
const W = wallet.toBase58();

// Shaped like Connection.getParsedTokenAccountsByOwner output.
function account({ amount = '0', program = SPL, owner = W, mint = MINT, state = 'initialized', closeAuthority, isNative = false, lamports = 2039280 } = {}) {
  const info = { mint, owner, state, isNative, tokenAmount: { amount, decimals: 6 } };
  if (closeAuthority) info.closeAuthority = closeAuthority;
  return { pubkey: Keypair.generate().publicKey,
    account: { owner: new PublicKey(program), lamports, data: { program: 'spl-token', parsed: { type: 'account', info } } } };
}
function connection(accounts) {
  const calls = [];
  return { calls,
    getParsedTokenAccountsByOwner: async (owner, filter) => { calls.push([owner.toBase58(), filter.mint.toBase58()]); return { context: { slot: 1 }, value: accounts }; },
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 500 }) };
}

test('the close transaction only closes empty accounts and sends the rent back to the wallet', async () => {
  const empty = account(); const empty2022 = account({ program: TOKEN_2022, lamports: 2074080 });
  const conn = connection([empty, account({ amount: '5' }), empty2022]);
  const built = await buildReclaimTransaction({ connection: conn, wallet: W, mint: MINT });
  assert.deepEqual(conn.calls, [[W, MINT]]);
  assert.equal(built.refundLamports, String(2039280 + 2074080));
  assert.equal(built.lastValidBlockHeight, 500);
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, 'base64'));
  const keys = tx.message.staticAccountKeys.map(k => k.toBase58());
  assert.equal(keys[0], W, 'the wallet pays the fee');
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.equal(tx.signatures[0].every(b => b === 0), true, 'unsigned');
  const closes = tx.message.compiledInstructions.map(ix => ({ program: keys[ix.programIdIndex],
    accounts: ix.accountKeyIndexes.map(i => keys[i]), data: [...ix.data] }));
  assert.deepEqual(closes, [
    { program: SPL, accounts: [empty.pubkey.toBase58(), W, W], data: [9] },
    { program: TOKEN_2022, accounts: [empty2022.pubkey.toBase58(), W, W], data: [9] },
  ]);
});

test('frozen, wrapped-SOL and accounts someone else can close are left alone; nothing to close is a 404', async () => {
  const skipped = [account({ amount: '1' }), account({ state: 'frozen' }), account({ isNative: true }),
    account({ closeAuthority: Keypair.generate().publicKey.toBase58() })];
  assert.deepEqual(await emptyTokenAccounts({ connection: connection(skipped), wallet: W, mint: MINT }), []);
  await assert.rejects(buildReclaimTransaction({ connection: connection(skipped), wallet: W, mint: MINT }),
    e => e.status === 404 && /no rent to get back/.test(e.message));
  // A close authority equal to the wallet is fine.
  assert.equal((await emptyTokenAccounts({ connection: connection([account({ closeAuthority: W })]), wallet: W, mint: MINT })).length, 1);
});

test('account data that does not match the wallet, coin or a token program is refused', async () => {
  for (const bad of [{ owner: Keypair.generate().publicKey.toBase58() }, { mint: 'So11111111111111111111111111111111111111112' },
    { program: Keypair.generate().publicKey.toBase58() }, { lamports: -1 }]) {
    await assert.rejects(buildReclaimTransaction({ connection: connection([account(bad)]), wallet: W, mint: MINT }), e => e.status === 502);
  }
  await assert.rejects(emptyTokenAccounts({ connection: connection([]), wallet: 'not-a-key', mint: MINT }), /Invalid wallet/);
});

test('the trade ledger accepts the close transaction as a LIVE reclaim build', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-reclaim-'));
  const saved = process.env.GMGN_TRADE_LEDGER_PATH;
  process.env.GMGN_TRADE_LEDGER_PATH = path.join(dir, 'ledger.json');
  t.after(() => {
    if (saved === undefined) delete process.env.GMGN_TRADE_LEDGER_PATH; else process.env.GMGN_TRADE_LEDGER_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const built = await buildReclaimTransaction({ connection: connection([account()]), wallet: W, mint: MINT });
  const authorize = side => authorizeBroadcast({ tradeId: `reclaim-test-${side}-01`, swapTransaction: built.transaction,
    walletAddress: W, side, mode: 'LIVE', lastValidBlockHeight: built.lastValidBlockHeight, intent: { inputMint: MINT } });
  assert.throws(() => authorize('refund'), /Only LIVE builds/);
  authorize('reclaim');
});
