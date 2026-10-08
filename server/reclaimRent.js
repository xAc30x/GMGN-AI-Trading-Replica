/**
 * Builds an unsigned transaction that closes the wallet's empty token accounts for one coin,
 * returning their rent (about 0.002 SOL each) to the same wallet. The wallet signs it in the
 * browser; this module never signs or sends anything.
 *
 * Only accounts the chain reports as owned by the wallet, holding zero tokens, not frozen, not
 * wrapped SOL, and closable by the wallet are included. The refund always goes to the wallet.
 */
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

export const TOKEN_PROGRAMS = Object.freeze([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
]);
const CLOSE_ACCOUNT = 9; // SPL Token instruction index, the same in both programs.
const MAX_ACCOUNTS = 4;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function publicKey(value, label) {
  try { return new PublicKey(value); } catch { return fail(`Invalid ${label}`); }
}

/** CloseAccount: [account (writable), destination (writable), owner (signer)], data = [9]. */
export function closeAccountInstruction({ programId, account, owner }) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([CLOSE_ACCOUNT]),
  });
}

/** Empty token accounts for this wallet and coin that the wallet itself can close. */
export async function emptyTokenAccounts({ connection, wallet, mint }) {
  const owner = publicKey(wallet, 'wallet address');
  const mintKey = publicKey(mint, 'coin address');
  const result = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintKey });
  const closable = [];
  for (const { pubkey, account } of result?.value ?? []) {
    const info = account?.data?.parsed?.info;
    const program = account?.owner?.toBase58?.() ?? String(account?.owner);
    if (!TOKEN_PROGRAMS.includes(program) || !info || info.mint !== mintKey.toBase58() || info.owner !== owner.toBase58()) {
      fail('Token account data does not match this wallet and coin', 502);
    }
    if (!Number.isSafeInteger(account.lamports) || account.lamports <= 0) fail('Token account balance is malformed', 502);
    const empty = info.tokenAmount?.amount === '0';
    const closer = info.closeAuthority ?? owner.toBase58();
    if (empty && info.state === 'initialized' && !info.isNative && closer === owner.toBase58()) {
      closable.push({ address: pubkey.toBase58?.() ?? String(pubkey), program, lamports: account.lamports });
    }
  }
  return closable.slice(0, MAX_ACCOUNTS);
}

/**
 * Unsigned close transaction for the empty accounts of one coin. Throws 404 when there is
 * nothing to close, for example when the sell already closed the account.
 */
export async function buildReclaimTransaction({ connection, wallet, mint }) {
  const accounts = await emptyTokenAccounts({ connection, wallet, mint });
  if (!accounts.length) fail('No empty token account for this coin; there is no rent to get back', 404);
  const owner = new PublicKey(wallet);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1) fail('Transaction expiry unavailable', 503);
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: accounts.map(a => closeAccountInstruction({
      programId: new PublicKey(a.program), account: new PublicKey(a.address), owner })),
  }).compileToV0Message();
  const transaction = Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
  const refundLamports = String(accounts.reduce((sum, a) => sum + BigInt(a.lamports), 0n));
  return { transaction, lastValidBlockHeight, accounts, refundLamports };
}
