/**
 * Preconditions shown in the LIVE unlock dialog. Pure function so it can be unit tested.
 * A `fail` item blocks unlocking LIVE; a `warn` item is shown but does not block.
 * These checks are a UI gate only: the server and the buy flow enforce their own.
 */

import type { HealthResponse } from './api';
import type { Chain } from './types';

export type PreflightStatus = 'pass' | 'warn' | 'fail';

export interface PreflightItem {
  label: string;
  status: PreflightStatus;
  detail: string;
}

/** Minutes after which LIVE switches itself back to PAPER. */
export const LIVE_SESSION_OPTIONS = [15, 30, 60] as const;
export type LiveSessionMinutes = (typeof LIVE_SESSION_OPTIONS)[number];

export interface LivePreflightInput {
  chain: Chain;
  health: Pick<HealthResponse, 'solLiveEnabled' | 'liveEnabled' | 'solBroadcastEnabled'> | null;
  tokenPresent: boolean;
  walletAddress: string | null;
  walletName: string | null;
  rpcIsPublic: boolean;
  unresolvedSignatures: number;
}

function short(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function livePreflight({
  chain, health, tokenPresent, walletAddress, walletName, rpcIsPublic, unresolvedSignatures,
}: LivePreflightInput): PreflightItem[] {
  const items: PreflightItem[] = [];
  items.push(tokenPresent
    ? { label: 'Access token', status: 'pass', detail: 'in this browser session' }
    : { label: 'Access token', status: 'fail', detail: 'paste it in Settings' });

  if (!health) {
    items.push({ label: 'Server status', status: 'fail', detail: 'server not reachable' });
    return items;
  }

  const liveFlag = Boolean(health.solLiveEnabled ?? health.liveEnabled);
  items.push(liveFlag
    ? { label: 'GMGN_LIVE', status: 'pass', detail: '1 · market data on' }
    : { label: 'GMGN_LIVE', status: 'fail', detail: 'off · set GMGN_LIVE=1 and restart' });

  if (chain !== 'SOL') {
    items.push({ label: 'Signing', status: 'pass', detail: `${chain}: intent only, nothing is signed here` });
    return items;
  }

  items.push(walletAddress
    ? { label: 'Wallet connected', status: 'pass', detail: `${walletName || 'wallet'} ${short(walletAddress)}` }
    : { label: 'Wallet connected', status: 'fail', detail: 'connect Phantom or Solflare' });

  items.push(health.solBroadcastEnabled
    ? { label: 'GMGN_SOL_BROADCAST', status: 'pass', detail: '1 · sends allowed' }
    : { label: 'GMGN_SOL_BROADCAST', status: 'fail', detail: 'unset · no sends (PAPER does not need it)' });

  items.push(rpcIsPublic
    ? { label: 'RPC', status: 'warn', detail: 'public mainnet · unreliable for trading' }
    : { label: 'RPC', status: 'pass', detail: 'dedicated' });

  const pending = unresolvedSignatures;
  items.push(pending === 0
    ? { label: 'Unresolved signatures', status: 'pass', detail: 'none' }
    : { label: 'Unresolved signatures', status: 'warn', detail: `${pending} pending · reconcile before new trades` });

  return items;
}
