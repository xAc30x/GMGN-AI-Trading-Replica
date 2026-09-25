export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Default public RPC — override with VITE_SOLANA_RPC_URL for reliability. */
export const SOLANA_RPC =
  (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined)?.trim() ||
  'https://api.mainnet-beta.solana.com';

export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 300;

export function isPublicSolanaRpc(url: string = SOLANA_RPC): boolean {
  return /api\.mainnet-beta\.solana\.com/i.test(url);
}
