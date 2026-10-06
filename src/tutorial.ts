/** Saved once the first-launch tour is finished or skipped. */
export const TUTORIAL_STORAGE_KEY = 'gmgn.tutorial.seen.v1';

/** Where a step points: the element carrying `data-tour="<target>"`. */
export type TutorialTarget =
  | 'mode-banner'
  | 'mode-switch'
  | 'tabs'
  | 'chain'
  | 'wallet'
  | 'discover'
  | 'watchlist'
  | 'inspector'
  | 'holdings'
  | 'activity'
  | 'status-bar'
  | 'settings';

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  /** Element to highlight. Without one, or when it is not on screen, the step shows centered. */
  target?: TutorialTarget;
  /** Shown instead of highlighting when the target is not on screen in the current mode. */
  whenHidden?: string;
}

const WORKSPACE_HIDDEN = 'This panel appears when you switch to PAPER or LIVE on the SOL chain.';

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to AI Trader',
    body:
      'AI Trader finds Solana tokens, runs safety checks on them, and lets you practice or trade with swaps your own wallet signs. ' +
      'This short tour shows where everything is. You can skip it at any time and replay it from Settings.',
  },
  {
    id: 'mode-switch',
    target: 'mode-switch',
    title: 'Trading mode',
    body:
      'SHADOW shows mock data only. PAPER uses real prices and safety checks with virtual SOL, and nothing is sent. ' +
      'LIVE uses real funds: it has to be unlocked first, locks itself again after a set time, and your wallet must approve every transaction.',
  },
  {
    id: 'mode-banner',
    target: 'mode-banner',
    title: 'Mode banner',
    body: 'This strip always says which mode you are in and what it can do. In LIVE it shows the auto-lock countdown and a LOCK NOW button.',
  },
  {
    id: 'tabs',
    target: 'tabs',
    title: 'Pages',
    body:
      'Trade is the main workspace. Research shows the background research the server runs on real Solana data (PAPER on SOL, needs the access token). ' +
      'Wallet eval is a demo screen with example data; it does not fetch real wallet history yet.',
  },
  {
    id: 'chain',
    target: 'chain',
    title: 'Chain',
    body: 'Trading works on SOL. Other chains show quotes and intents only. Changing the chain switches the app back to SHADOW.',
  },
  {
    id: 'wallet',
    target: 'wallet',
    title: 'Your wallet',
    body: 'Connect Phantom or Solflare here. You only need it for LIVE. The app never holds your keys; your wallet signs each swap.',
  },
  {
    id: 'discover',
    target: 'discover',
    whenHidden: WORKSPACE_HIDDEN,
    title: 'Discover',
    body:
      'New and boosted tokens from DexScreener, each with a safety verdict. Click a token to inspect it, or use + Watch to add it to your watchlist.',
  },
  {
    id: 'watchlist',
    target: 'watchlist',
    whenHidden: WORKSPACE_HIDDEN,
    title: 'Watchlist',
    body:
      'Up to 8 tokens you want to follow. Each row is a real on-chain, RugCheck and GoPlus scan. Set the buy amount here and use Rescan to refresh.',
  },
  {
    id: 'inspector',
    target: 'inspector',
    whenHidden: WORKSPACE_HIDDEN,
    title: 'Inspector',
    body:
      'Shows the selected token in detail: price, liquidity and every safety check. You can buy from here; a blocked token cannot be bought.',
  },
  {
    id: 'holdings',
    target: 'holdings',
    title: 'Tracked holdings',
    body: 'Your open positions with profit and loss. Use the 10% to 100% buttons to sell part or all of a holding.',
  },
  {
    id: 'activity',
    target: 'activity',
    title: 'Session activity',
    body: 'A running log of what happened in this session. It is cleared when you reload, so it is not a permanent record.',
  },
  {
    id: 'status-bar',
    target: 'status-bar',
    title: 'Status bar',
    body: "The latest activity, the server's hard trade limits, and whether the server is allowed to sign (it should normally say disabled).",
  },
  {
    id: 'settings',
    target: 'settings',
    title: 'Settings',
    body:
      'The setup checklist: access token, wallet, RPC, safety gates, trade limits, a tool to test any token, and experimental options. ' +
      'You can replay this tour from there.',
  },
  {
    id: 'done',
    title: "You're ready",
    body: 'Start in PAPER to practice with virtual SOL. Move to LIVE only when the setup checklist in Settings is complete.',
  },
];

/**
 * True when the tour should open on this load.
 * If storage cannot be read, the tour stays closed so it does not reopen on every reload; Settings can still replay it.
 */
export function shouldShowTutorial(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_STORAGE_KEY) !== 'true';
  } catch {
    return false;
  }
}

/** Remembers that the tour was finished or skipped. A blocked write only means it may show again next load. */
export function markTutorialSeen(): void {
  try {
    localStorage.setItem(TUTORIAL_STORAGE_KEY, 'true');
  } catch {
    // Storage blocked: nothing else to do.
  }
}
