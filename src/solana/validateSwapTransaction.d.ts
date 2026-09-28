import type { Connection } from '@solana/web3.js';

export interface SwapTransactionIntent {
  swapTransaction: string;
  connection: Pick<Connection, 'getAddressLookupTable' | 'getAccountInfo' | 'getFeeForMessage'>;
  walletPublicKey: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  quotedOutput: string;
  minimumOutput: string;
  slippageBps: number;
}

export function validateSwapTransaction(
  intent: SwapTransactionIntent,
): Promise<{ priorityFeeLamports: string; transactionFeeLamports: number }>;