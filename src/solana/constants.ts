import { Connection } from '@solana/web3.js';
import { getLocalToken } from '../localToken';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';


const CUSTOM_RPC = (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined)?.trim() || '';

/**
 * Browser RPC endpoint. The public Solana RPC answers 403 to requests sent from a browser page,
 * so by default the browser goes through the local server's /api/sol/rpc proxy, which forwards
 * to SOLANA_RPC_URL (public RPC when unset). Set VITE_SOLANA_RPC_URL to call a dedicated RPC directly.
 */
export const RPC_PROXY_PATH = '/api/sol/rpc';
export const SOLANA_RPC =
  CUSTOM_RPC ||
  (typeof window !== 'undefined' ? `${window.location.origin}${RPC_PROXY_PATH}` : 'http://127.0.0.1:5173' + RPC_PROXY_PATH);
export const USING_RPC_PROXY = !CUSTOM_RPC;

/** HTTP-only connection (confirmation polls, no websocket), with the local token when proxied. */
export function makeConnection(): Connection {
  const token = getLocalToken();
  return new Connection(SOLANA_RPC, {
    commitment: 'confirmed',
    httpHeaders: USING_RPC_PROXY && token ? { 'X-GMGN-Token': token } : undefined,
  });
}

export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 300;

export function isPublicSolanaRpc(url: string = SOLANA_RPC): boolean {
  return /api\.mainnet-beta\.solana\.com/i.test(url);
}
