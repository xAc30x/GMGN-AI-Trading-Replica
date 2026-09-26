import type { Connection } from '@solana/web3.js';

type ConfirmConnection = Pick<Connection, 'getSignatureStatuses' | 'getBlockHeight'>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls signature status over HTTP (no websocket, so it works through the local RPC proxy).
 * Succeeds on confirmed/finalized, throws on execution error, and throws a recoverable
 * "confirmation unknown" error once the blockhash has expired or the timeout passes.
 */
export async function confirmSwap(
  connection: ConfirmConnection,
  signature: string,
  _blockhash: string,
  lastValidBlockHeight: number,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const unknown = () =>
    new Error('Confirmation unknown for ' + signature + '. Check this signature before retrying.');
  for (;;) {
    let status;
    try {
      const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
      status = res.value[0];
    } catch {
      status = undefined;
    }
    if (status?.err) {
      throw new Error('Transaction failed: ' + signature + ' (' + JSON.stringify(status.err) + ')');
    }
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return;
    }
    if (Date.now() > deadline) throw unknown();
    try {
      if ((await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) {
        // One last look: it may have landed right before expiry.
        const last = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        if (last?.err) throw new Error('Transaction failed: ' + signature + ' (' + JSON.stringify(last.err) + ')');
        if (last && last.confirmationStatus && last.confirmationStatus !== 'processed') return;
        throw unknown();
      }
    } catch (e) {
      if (e instanceof Error && /Transaction failed|Confirmation unknown/.test(e.message)) throw e;
    }
    await sleep(intervalMs);
  }
}
