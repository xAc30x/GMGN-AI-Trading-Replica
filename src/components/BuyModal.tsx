import { useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  buildTradeIntent,
  fetchHealth,
  fetchMintSafety,
  fetchQuote,
  fetchSolQuote,
  type MintSafetyResponse,
  type QuoteResponse,
  type SolQuoteResponse,
} from '../api';
import { isDemoTokenAddress } from '../data/mockData';
import { hasLocalToken } from '../localToken';
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS } from '../solana/constants';
import { paperSimulateSolSwap, signAndSendSolSwap } from '../solana/sendJupiterSwap';
import type { Chain, ScreenToken, TradeMode } from '../types';

interface Props {
  token: ScreenToken | null;
  amount: number;
  mode: TradeMode;
  chain: Chain;
  onClose: () => void;
  onConfirm: (token: ScreenToken, amount: number, meta?: LiveBuyMeta) => void;
}

export interface LiveBuyMeta {
  orderId?: string;
  hash?: string;
  explorerUrl?: string | null;
  tokenAddress: string;
  live: boolean;
  intentOnly?: boolean;
  walletSigned?: boolean;
  paper?: boolean;
}

const NATIVE_HINT: Record<string, string> = {
  SOL: 'SOL',
  BSC: 'BNB',
  Base: 'ETH',
  ETH: 'ETH',
};

export function BuyModal({ token, amount, mode, chain, onClose, onConfirm }: Props) {
  const wallet = useWallet();
  const { connection: _connection } = useConnection();
  void _connection;

  const [amt, setAmt] = useState(String(amount));
  const [tokenAddress, setTokenAddress] = useState('');
  const [caConfirm, setCaConfirm] = useState('');
  const [understand, setUnderstand] = useState(false);
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [solQuote, setSolQuote] = useState<SolQuoteResponse | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [maxNative, setMaxNative] = useState(0.05);
  const [maxSlip, setMaxSlip] = useState(MAX_SLIPPAGE_BPS);
  const [mintSafety, setMintSafety] = useState<MintSafetyResponse | null>(null);
  const [safetyLoading, setSafetyLoading] = useState(false);

  const isArmed = mode === 'LIVE' || mode === 'PAPER';
  const isPaper = mode === 'PAPER';
  const isSolLive = isArmed && chain === 'SOL';

  useEffect(() => {
    if (!token) return;
    setAmt(String(amount));
    setTokenAddress('');
    setCaConfirm('');
    setUnderstand(false);
    setQuote(null);
    setSolQuote(null);
    setQuoteErr(null);
    setStatusMsg(null);
    setMintSafety(null);
    void fetchHealth()
      .then((h) => {
        if (typeof h.maxNativeAmount === 'number' && h.maxNativeAmount > 0) {
          setMaxNative(h.maxNativeAmount);
        }
        if (typeof h.maxSlippageBps === 'number' && h.maxSlippageBps > 0) {
          setMaxSlip(h.maxSlippageBps);
        }
        if (typeof h.defaultSlippageBps === 'number' && h.defaultSlippageBps > 0) {
          setSlippageBps(h.defaultSlippageBps);
        }
      })
      .catch(() => undefined);
  }, [token, amount]);

  useEffect(() => {
    if (!token || !isArmed) return;
    const ca = tokenAddress.trim();
    const n = Number(amt);
    if (!ca || isDemoTokenAddress(ca) || !Number.isFinite(n) || n <= 0 || n > maxNative) return;
    if (!hasLocalToken()) return;

    let cancelled = false;
    const t = window.setTimeout(() => {
      setQuoting(true);
      setQuoteErr(null);
      const req = isSolLive
        ? fetchSolQuote({
            outputMint: ca,
            amount: n,
            slippageBps,
          }).then((q) => {
            if (!cancelled) {
              setSolQuote(q);
              setQuote(null);
            }
          })
        : fetchQuote({
            chain,
            outputToken: ca,
            amount: n,
            slippage: 30,
          }).then((q) => {
            if (!cancelled) {
              setQuote(q);
              setSolQuote(null);
            }
          });

      void req
        .catch((e) => {
          if (!cancelled) {
            setQuote(null);
            setSolQuote(null);
            setQuoteErr(e instanceof Error ? e.message : String(e));
          }
        })
        .finally(() => {
          if (!cancelled) setQuoting(false);
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [token, isArmed, isSolLive, chain, tokenAddress, amt, maxNative, slippageBps]);

  useEffect(() => {
    if (!isSolLive) {
      setMintSafety(null);
      return;
    }
    const ca = tokenAddress.trim();
    if (ca.length < 32 || isDemoTokenAddress(ca) || !hasLocalToken()) {
      setMintSafety(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      setSafetyLoading(true);
      void fetchMintSafety(ca)
        .then((s) => {
          if (!cancelled) setMintSafety(s);
        })
        .catch((e) => {
          if (!cancelled) {
            setMintSafety({
              ok: false,
              mint: ca,
              checks: [],
              blockers: [e instanceof Error ? e.message : String(e)],
              mintAuthority: null,
              freezeAuthority: null,
            });
          }
        })
        .finally(() => {
          if (!cancelled) setSafetyLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [isSolLive, tokenAddress]);

  if (!token) return null;

  const ca = tokenAddress.trim();
  const nAmt = Number(amt);
  const caOk =
    ca.length >= 32 &&
    !isDemoTokenAddress(ca) &&
    caConfirm.trim() === ca &&
    hasLocalToken() &&
    Number.isFinite(nAmt) &&
    nAmt > 0 &&
    nAmt <= maxNative;

  const safetyOk = Boolean(mintSafety?.ok);
  const canSolSign =
    isSolLive &&
    !isPaper &&
    understand &&
    caOk &&
    !submitting &&
    !safetyLoading &&
    safetyOk &&
    Boolean(wallet.publicKey) &&
    Boolean(wallet.signTransaction) &&
    slippageBps >= 1 &&
    slippageBps <= maxSlip;

  const canSolPaper =
    isSolLive &&
    isPaper &&
    understand &&
    caOk &&
    !submitting &&
    !safetyLoading &&
    safetyOk &&
    Boolean(wallet.publicKey) &&
    slippageBps >= 1 &&
    slippageBps <= maxSlip;

  const canCopyIntent = isArmed && !isSolLive && caOk;

  const handleShadow = () => {
    onConfirm(token, Number(amt) || amount);
  };

  const handleSolLive = async () => {
    if (!canSolSign) return;
    setSubmitting(true);
    setStatusMsg('Building Jupiter swap — approve in your wallet…');
    try {
      const result = await signAndSendSolSwap({
        wallet,
        outputMint: tokenAddress.trim(),
        amountSol: Number(amt) || amount,
        slippageBps,
        quote: solQuote?.quote,
      });
      setStatusMsg(`Confirmed: ${result.signature.slice(0, 12)}…`);
      onConfirm(token, Number(amt) || amount, {
        hash: result.signature,
        explorerUrl: result.explorerUrl,
        tokenAddress: tokenAddress.trim(),
        live: true,
        walletSigned: true,
      });
    } catch (e) {
      setStatusMsg(null);
      setQuoteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSolPaper = async () => {
    if (!canSolPaper || !wallet.publicKey) return;
    setSubmitting(true);
    setStatusMsg('PAPER: building + simulating Jupiter swap (nothing sent)…');
    try {
      const sim = await paperSimulateSolSwap({
        userPublicKey: wallet.publicKey.toBase58(),
        outputMint: tokenAddress.trim(),
        amountSol: Number(amt) || amount,
        slippageBps,
        quote: solQuote?.quote,
      });
      if (!sim.ok) {
        setQuoteErr(sim.err || 'Simulation failed');
        setStatusMsg(null);
        return;
      }
      setStatusMsg(
        `PAPER ok · ~${sim.unitsConsumed ?? '?'} CU · min out ${sim.otherAmountThreshold ?? sim.outAmount ?? '—'} (not sent)`,
      );
      onConfirm(token, Number(amt) || amount, {
        tokenAddress: tokenAddress.trim(),
        live: true,
        paper: true,
      });
    } catch (e) {
      setStatusMsg(null);
      setQuoteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyIntent = async () => {
    if (!canCopyIntent) return;
    const intent = buildTradeIntent({
      chain,
      outputToken: tokenAddress.trim(),
      amount: Number(amt) || amount,
      outputAmount: quote?.outputAmount,
      minOutputAmount: quote?.minOutputAmount,
      slippage: quote?.slippage,
    });
    try {
      await navigator.clipboard.writeText(intent);
      setStatusMsg('Trade intent copied. Complete the swap outside this app — EVM server signing is disabled.');
    } catch {
      setStatusMsg(intent);
    }
    onConfirm(token, Number(amt) || amount, {
      tokenAddress: tokenAddress.trim(),
      live: true,
      intentOnly: true,
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="buy-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span style={{ color: 'var(--lime)' }}>⚡</span>
          <h3 id="buy-title">One-Click Buy · {token.symbol}</h3>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="field">
          <label htmlFor="buy-amt">Buy amount (computed by fixed-fraction; adjustable)</label>
          <div className="inline-input">
            <input
              id="buy-amt"
              type="number"
              min={0.001}
              max={maxNative}
              step={0.01}
              value={amt}
              onChange={(e) => setAmt(e.target.value)}
              disabled={submitting}
            />
            <span style={{ color: 'var(--tan)' }}>{NATIVE_HINT[chain] || chain}</span>
          </div>
          <div className="help">
            Server cap is {maxNative} native per LIVE buy. SOL LIVE uses Jupiter + your wallet
            signature.
          </div>
        </div>

        {isArmed && (
          <div className="field">
            <label htmlFor="buy-ca">
              Token address (contract / mint) — required for LIVE
              {!token.address && (
                <span style={{ color: 'var(--orange)' }}> · mock token has no real CA</span>
              )}
            </label>
            <input
              id="buy-ca"
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value)}
              placeholder="Paste real mint / contract address"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
            {isDemoTokenAddress(tokenAddress) && (
              <div className="cred-msg err">That address is a demo placeholder and is blocked.</div>
            )}
          </div>
        )}

        {isArmed && (
          <div className="field">
            <label htmlFor="buy-ca-confirm">Re-type token address to confirm</label>
            <input
              id="buy-ca-confirm"
              value={caConfirm}
              onChange={(e) => setCaConfirm(e.target.value)}
              placeholder="Must match the address above exactly"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
          </div>
        )}

        {isSolLive && (
          <div className="field">
            <label htmlFor="buy-slip">Max slippage (bps) — hard-capped at {maxSlip}</label>
            <input
              id="buy-slip"
              type="number"
              min={1}
              max={maxSlip}
              step={1}
              value={slippageBps}
              onChange={(e) => setSlippageBps(Number(e.target.value) || DEFAULT_SLIPPAGE_BPS)}
              disabled={submitting}
            />
            <div className="help">100 bps = 1%. The Jupiter quote min-out uses this ceiling.</div>
          </div>
        )}

        {isArmed && (
          <div className="quote-box">
            {quoting && <div>Fetching quote…</div>}
            {!quoting && quoteErr && <div className="cred-msg err">{quoteErr}</div>}
            {!quoting && isSolLive && solQuote?.ok && (
              <div>
                Est. out (raw): <code>{solQuote.outAmount ?? '—'}</code>
                {solQuote.otherAmountThreshold != null && (
                  <>
                    {' '}
                    · min out: <code>{solQuote.otherAmountThreshold}</code>
                  </>
                )}
                {solQuote.priceImpactPct != null && (
                  <> · impact {Number(solQuote.priceImpactPct).toFixed(4)}%</>
                )}
                {solQuote.slippageBps != null && <> · {solQuote.slippageBps} bps</>}
              </div>
            )}
            {!quoting && !isSolLive && quote?.ok && (
              <div>
                Est. output (raw units): <code>{quote.outputAmount ?? '—'}</code>
                {quote.minOutputAmount != null && (
                  <>
                    {' '}
                    · min: <code>{quote.minOutputAmount}</code>
                  </>
                )}
              </div>
            )}
            {isSolLive && !wallet.publicKey && (
              <div className="help">Connect Phantom or Solflare in the header to sign.</div>
            )}
          </div>
        )}


        {isSolLive && (tokenAddress.trim().length >= 32) && (
          <div className="quote-box mint-safety">
            <strong>Mint safety</strong>
            {safetyLoading && <div>Checking on-chain mint…</div>}
            {!safetyLoading && mintSafety && mintSafety.rug?.rugcheck && (
              <div className="help">
                RugCheck score {mintSafety.rug.rugcheck.scoreNormalised ?? '—'}
                {mintSafety.rug.rugcheck.totalMarketLiquidity != null && (
                  <> · liq ${Number(mintSafety.rug.rugcheck.totalMarketLiquidity).toFixed(0)}</>
                )}
                {mintSafety.rug.rugcheck.totalHolders != null && (
                  <> · holders {mintSafety.rug.rugcheck.totalHolders}</>
                )}
              </div>
            )}
            {!safetyLoading && mintSafety && (
              <ul className="mint-safety-list">
                {mintSafety.checks.map((c) => (
                  <li key={c.id} className={c.ok ? 'pos' : 'neg'}>
                    {c.ok ? '✓' : '✗'} {c.detail}
                  </li>
                ))}
              </ul>
            )}
            {!safetyLoading && mintSafety && !mintSafety.ok && (
              <div className="cred-msg err">
                Blocked: {(mintSafety.blockers && mintSafety.blockers[0]) || 'failed checks'}
              </div>
            )}
            {!safetyLoading && mintSafety?.warnings && mintSafety.warnings.length > 0 && mintSafety.ok && (
              <div className="help">Warnings: {mintSafety.warnings.slice(0, 3).join(' · ')}</div>
            )}
            <div className="help">
              Full scan: on-chain authorities + RugCheck + GoPlus. Danger findings block Sign.
            </div>
          </div>
        )}

        <div className="exit-plan">
          <h4>Notional exit idea (NOT placed on-chain)</h4>
          <pre>SL -35% · TP +60%→sell 40% / +150%→sell 30% · trailing 25%</pre>
          <div className="thesis">
            This replica does not submit stop-loss, take-profit, or trailing orders.
          </div>
          <div className="thesis">Thesis: {token.thesis}</div>
        </div>

        <div className={`shadow-box ${isArmed ? 'live-warn' : ''}`}>
          {mode === 'SHADOW'
            ? 'SHADOW mode: confirm to record intent only, no real order.'
            : isPaper && isSolLive
              ? 'SOL PAPER: runs mint/rug checks, builds a Jupiter tx, and simulates on RPC. Nothing is signed or sent.'
              : isSolLive
                ? 'SOL LIVE: Jupiter builds an unsigned swap; your wallet must approve amount, mint, and slippage. Irreversible once confirmed.'
                : 'LIVE/PAPER on this chain: quote + copy intent only. Switch chain to SOL for wallet-signed or paper simulates.'}
        </div>

        {isSolLive && (
          <label className="live-check">
            <input
              type="checkbox"
              checked={understand}
              onChange={(e) => setUnderstand(e.target.checked)}
              disabled={submitting}
            />
            <span>{isPaper ? 'I understand PAPER still uses real quotes/routes (no send)' : 'I understand my wallet will spend real SOL'}</span>
          </label>
        )}

        {statusMsg && <div className="status-line">{statusMsg}</div>}

        <div className="modal-actions">
          {isSolLive && isPaper ? (
            <button
              type="button"
              className="btn-primary"
              disabled={!canSolPaper}
              onClick={() => void handleSolPaper()}
            >
              {submitting ? 'Simulating…' : 'Simulate SOL swap (paper)'}
            </button>
          ) : isSolLive ? (
            <button
              type="button"
              className="btn-primary btn-danger"
              disabled={!canSolSign}
              onClick={() => void handleSolLive()}
            >
              {submitting ? 'Waiting for wallet…' : 'Sign SOL swap in wallet'}
            </button>
          ) : isArmed ? (
            <button
              type="button"
              className="btn-primary"
              disabled={!canCopyIntent}
              onClick={() => void handleCopyIntent()}
            >
              Copy trade intent
            </button>
          ) : (
            <button type="button" className="btn-primary" onClick={handleShadow}>
              Confirm buy
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
