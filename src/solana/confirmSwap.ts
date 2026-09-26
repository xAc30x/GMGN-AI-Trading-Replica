import type { Connection } from '@solana/web3.js';

export async function confirmSwap(
  connection: Pick<Connection, 'confirmTransaction'>,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  let result;
  try {
    result = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight }, 'confirmed',
    );
  } catch {
    throw new Error('Confirmation unknown for ' + signature + '. Check this signature before retrying.');
  }
  if (result.value.err) {
    throw new Error('Transaction failed: ' + signature + ' (' + JSON.stringify(result.value.err) + ')');
  }
}
