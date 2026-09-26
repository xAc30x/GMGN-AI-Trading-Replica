import {
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import { fetchMintSafety, fetchSolCloseTx, fetchSolSwapTx } from '../api';
import { confirmSwap } from './confirmSwap.ts';
import { makeConnection } from './constants';

async function signSendBase64(
  wallet: WalletContextState,
  swapTransaction: string,
  lastValidBlockHeight?: number,
): Promise<{ signature: string; explorerUrl: string }> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Connect a Solana wallet that can sign transactions');
  }
  const raw = Uint8Array.from(atob(swapTransaction), (c) => c.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(raw);
  if (!Number.isSafeInteger(lastValidBlockHeight) || !lastValidBlockHeight || lastValidBlockHeight < 1) {
    throw new Error('Transaction expiry is missing or invalid');
  }
  if (tx.message.header.numRequiredSignatures !== 1 ||
      !tx.message.staticAccountKeys[0]?.equals(wallet.publicKey)) {
    throw new Error('Transaction signer does not match the connected wallet');
  }
  const originalMessage = tx.message.serialize();
  const signed = await wallet.signTransaction(tx);
  const signedMessage = signed.message.serialize();
  if (signedMessage.length !== originalMessage.length ||
      !signedMessage.every((v, i) => v === originalMessage[i])) {
    throw new Error('Wallet returned a modified transaction');
  }
  const connection = makeConnection();
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await confirmSwap(connection, signature, tx.message.recentBlockhash, lastValidBlockHeight!);
  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
  };
}

export async function requireMintSafe(mint: string): Promise<void> {
  const safety = await fetchMintSafety(mint);
  if (!safety.ok) {
    throw new Error(safety.blockers?.[0] || safety.error || 'Mint failed safety checks');
  }
}

async function executeSolSwap(args: {
  wallet: WalletContextState;
  outputMint: string;
  amountSol: number;
  slippageBps: number;
}): Promise<{ signature: string; explorerUrl: string }> {
  const { wallet, outputMint, amountSol, slippageBps } = args;
  await requireMintSafe(outputMint);
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Connect a Solana wallet that can sign transactions');
  }
  const built = await fetchSolSwapTx({
    outputMint,
    amount: amountSol,
    slippageBps,
    userPublicKey: wallet.publicKey.toBase58(),
    confirm: true,
    mode: 'LIVE',
  });
  return signSendBase64(wallet, built.swapTransaction, built.lastValidBlockHeight);
}

export async function getTokenBalanceAtomic(
  owner: PublicKey,
  mint: string,
): Promise<{ amountAtomic: string; decimals: number }> {
  const connection = makeConnection();
  const mintPk = new PublicKey(mint);
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintPk });
  let total = 0n;
  let decimals = 0;
  for (const a of accounts.value) {
    const info = a.account.data.parsed?.info?.tokenAmount;
    if (!info) continue;
    decimals = Number(info.decimals ?? 0);
    total += BigInt(info.amount || '0');
  }
  if (total <= 0n) {
    throw new Error('No token balance in this wallet for that mint');
  }
  return { amountAtomic: String(total), decimals };
}

async function executeSolClose(args: {
  wallet: WalletContextState;
  inputMint: string;
  percent?: number;
  slippageBps: number;
}): Promise<{ signature: string; explorerUrl: string; amountAtomic: string }> {
  const { wallet, inputMint, percent = 100, slippageBps } = args;
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Connect a Solana wallet that can sign transactions');
  }
  await requireMintSafe(inputMint);
  const bal = await getTokenBalanceAtomic(wallet.publicKey, inputMint);
  const built = await fetchSolCloseTx({
    inputMint,
    balanceAtomic: bal.amountAtomic,
    percent,
    slippageBps,
    userPublicKey: wallet.publicKey.toBase58(),
    confirm: true,
    mode: 'LIVE',
  });
  const sent = await signSendBase64(wallet, built.swapTransaction, built.lastValidBlockHeight);
  return { ...sent, amountAtomic: built.inAmount || bal.amountAtomic };
}

/** PAPER mode: mint-safety + build Jupiter tx + RPC simulate. Never signs or sends. */
export async function paperSimulateSolSwap(args: {
  userPublicKey: string;
  outputMint: string;
  amountSol: number;
  slippageBps: number;
}): Promise<{
  ok: boolean;
  unitsConsumed?: number;
  logs?: string[];
  err?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
}> {
  const { userPublicKey, outputMint, amountSol, slippageBps } = args;
  await requireMintSafe(outputMint);
  const built = await fetchSolSwapTx({
    outputMint,
    amount: amountSol,
    slippageBps,
    userPublicKey,
    confirm: true,
    mode: 'LIVE',
  });
  const raw = Uint8Array.from(atob(built.swapTransaction), (c) => c.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(raw);
  const connection = makeConnection();
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (sim.value.err) {
    return {
      ok: false,
      err: typeof sim.value.err === 'string' ? sim.value.err : JSON.stringify(sim.value.err),
      logs: sim.value.logs || undefined,
      unitsConsumed: sim.value.unitsConsumed,
      inAmount: built.inAmount,
      outAmount: built.outAmount,
      otherAmountThreshold: built.otherAmountThreshold,
    };
  }
  return {
    ok: true,
    unitsConsumed: sim.value.unitsConsumed,
    logs: sim.value.logs || undefined,
    inAmount: built.inAmount,
    outAmount: built.outAmount,
    otherAmountThreshold: built.otherAmountThreshold,
  };
}

let walletActionBusy = false;
async function withWalletAction<T>(action: () => Promise<T>): Promise<T> {
  if (walletActionBusy) throw new Error('A wallet transaction is already awaiting approval or confirmation');
  walletActionBusy = true;
  try { return await action(); }
  finally { walletActionBusy = false; }
}
export function signAndSendSolSwap(args: Parameters<typeof executeSolSwap>[0]) {
  return withWalletAction(() => executeSolSwap(args));
}
export function signAndSendSolClose(args: Parameters<typeof executeSolClose>[0]) {
  return withWalletAction(() => executeSolClose(args));
}
