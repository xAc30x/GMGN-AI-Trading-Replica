import type { VersionedTransaction } from '@solana/web3.js';

export function validateReclaimTransaction(intent: {
  transaction: string;
  walletPublicKey: string;
  accounts: string[];
}): VersionedTransaction;
