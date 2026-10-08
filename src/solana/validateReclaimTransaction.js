import { VersionedTransaction } from '@solana/web3.js';

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const CLOSE_ACCOUNT = 9;
const MAX_ACCOUNTS = 4;

function fail(reason) {
  throw new Error(`Unsafe account close transaction: ${reason}`);
}

/**
 * Independent browser check of a server-built rent reclaim, before the wallet is asked to sign.
 * It must contain only CloseAccount instructions for the listed accounts, each sending the rent
 * to the connected wallet and signed by it, with the wallet as the only signer and fee payer.
 */
export function validateReclaimTransaction({ transaction, walletPublicKey, accounts }) {
  let tx;
  try { tx = VersionedTransaction.deserialize(Uint8Array.from(atob(transaction), c => c.charCodeAt(0))); }
  catch { fail('cannot be decoded'); }
  const message = tx.message;
  if (message.version !== 0 || message.addressTableLookups.length) fail('unexpected transaction format');
  if (message.header.numRequiredSignatures !== 1 || tx.signatures.length !== 1) fail('must need exactly one signature');
  if (tx.signatures[0].some(byte => byte !== 0)) fail('is already signed');
  const keys = message.staticAccountKeys.map(key => key.toBase58());
  if (keys[0] !== walletPublicKey) fail('fee payer is not the connected wallet');
  const expected = new Set(accounts);
  if (!accounts.length || accounts.length > MAX_ACCOUNTS || expected.size !== accounts.length) fail('unexpected account list');
  const closed = new Set();
  if (message.compiledInstructions.length !== accounts.length) fail('unexpected number of instructions');
  for (const ix of message.compiledInstructions) {
    if (!TOKEN_PROGRAMS.has(keys[ix.programIdIndex])) fail('calls a program other than the token program');
    if (ix.data.length !== 1 || ix.data[0] !== CLOSE_ACCOUNT) fail('contains an instruction other than closing an account');
    const [account, destination, owner, ...extra] = ix.accountKeyIndexes.map(index => keys[index]);
    if (extra.length || !account || !expected.has(account) || closed.has(account)) fail('closes an unexpected account');
    if (destination !== walletPublicKey) fail('sends the rent somewhere other than the connected wallet');
    if (owner !== walletPublicKey) fail('closing authority is not the connected wallet');
    closed.add(account);
  }
  return tx;
}
