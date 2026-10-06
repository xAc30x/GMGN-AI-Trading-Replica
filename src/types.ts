export type Chain = 'SOL' | 'BSC' | 'Base' | 'ETH';
export type TradeMode = 'SHADOW' | 'PAPER' | 'LIVE';
export type TabId = 'token' | 'research' | 'wallet';
export type LogKind = 'SCREEN' | 'FILTER' | 'BUY' | 'SELL';

export interface ScreenToken {
  id: string;
  symbol: string;
  mintShort: string;
  /** Contract / mint address. Mock placeholders for SHADOW; paste real CA for LIVE. */
  address?: string;
  age: string;
  ruleIcons: ('pass' | 'warn' | 'fail' | 'neutral')[];
  safe: string;
  safeOk: boolean;
  bund: number;
  dev: number;
  t10: number;
  smart: number;
  kol: number;
  devScore: number;
  devLabel: 'GOOD' | 'OK' | 'BAD';
  timing: string;
  llm: 'PASS' | 'HOLD' | 'FAIL';
  priority: number;
  decision: 'buy' | 'blocked' | 'watch';
  thesis: string;
  llmReason?: string;
}

export interface Position {
  id: string;
  symbol: string;
  walletAddress?: string;
  signature?: string;
  tradeSignatures?: string[];
  /** Token CA for LIVE close */
  address?: string;
  chain?: Chain;
  /** Seeded demo row — never eligible for LIVE close */
  demo?: boolean;
  pnlPct: number;
  alert?: boolean;
  sizeSol: number;
  entryAge: string;
}

export interface LogEntry {
  id: string;
  ts: string;
  kind: LogKind;
  category: string;
  message: string;
}

export interface WalletFactor {
  key: string;
  label: string;
  score: number;
  detail: string;
}

export interface WalletEvalData {
  address: string;
  addressShort: string;
  chain: string;
  activeDays: number;
  pnl7d: number;
  roi7d: number;
  style: string;
  styleTags: string[];
  insights: { title: string; body: string; icon: string }[];
  stats: { label: string; value: string; tone?: 'pos' | 'warn' | 'neg' | 'muted' }[];
  pnlBuckets: { label: string; count: number; color: string }[];
  trackScore: number;
  copyScore: number;
  devScore: number;
  warning: string;
  trackFactors: WalletFactor[];
  copyFactors: WalletFactor[];
  devFactors: WalletFactor[];
  edgeType: string;
  edgeScore: number;
  footerWarn: string;
  walletPerTradePct: number;
  wallet7dUsd: number;
}
