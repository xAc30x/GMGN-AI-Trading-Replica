import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { fetchSolQuote, type HealthResponse, type SolQuoteResponse } from '../api';
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS } from '../solana/constants';
import { signAndSendSolSwap, type CheckedSwap } from '../solana/sendJupiterSwap';
import type { TradeGate } from '../tradeGate';
import { CHECKED_BEFORE_WALLET, checkedRows, quotePreview } from '../txPreview';
import { HoldButton } from './HoldButton';

export interface LiveBought {
  signature: string;
  explorerUrl: string;
  walletAddress: string;
  /** The amount actually sent, which may differ from the current preset if it changed meanwhile. */
  amountSol: number;
}

interface Props {
  mint: string;
  symbol: string;
  decimals: number | undefined;
  amount: number;
  health: HealthResponse | null;
  /** Result of the inspector's own checks (verdict, holding, limits, acknowledgement). */
  gate: TradeGate;
  onBought: (r: LiveBought) => void;
  /** Called after a failed send so pending trade records get reconciled. */
  onReconcile: () => void;
}

function slippageFor(health: HealthResponse | null): number {
  const max = health?.maxSlippageBps ?? MAX_SLIPPAGE_BPS;
  const wanted = health?.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  return Math.min(Math.max(1, wanted), max);
}

/**
 * LIVE buy from the inspector: a quote-based preview and a hold-to-send button.
 * Sending goes through the existing signAndSendSolSwap, which re-checks the mint on the server,
 * builds the transaction there, decodes and checks it here, and only then asks the wallet.
 */
export function LiveSend({ mint, symbol, decimals, amount, health, gate, onBought, onReconcile }: Props) {
  const wallet = useWallet();
  const slippageBps = slippageFor(health);
  const quoteKey = `${mint}|${amount}|${slippageBps}`;
  const [quote, setQuote] = useState<{ key: string; res: SolQuoteResponse } | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [checked, setChecked] = useState<CheckedSwap | null>(null);

  // Quote only when the inspector's own rules allow trading; never for blocked or held tokens.
  useEffect(() => {
    if (!gate.can) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      fetchSolQuote({ outputMint: mint, amount, slippageBps })
        .then((res) => { if (!cancelled) { setQuote({ key: quoteKey, res }); setQuoteErr(res.ok ? null : res.error || 'Quote failed'); } })
        .catch((e) => { if (!cancelled) setQuoteErr(e instanceof Error ? e.message : String(e)); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [gate.can, mint, amount, slippageBps, quoteKey]);

  const current = quote?.key === quoteKey && quote.res.ok ? quote.res : null;
  const canSign = Boolean(wallet.publicKey && wallet.signTransaction);
  const label = !gate.can
    ? gate.label
    : sending
      ? 'Waiting for wallet…'
      : !canSign
        ? 'Connect a wallet that can sign'
        : quoteErr
          ? 'No valid quote'
          : !current
            ? 'Getting a quote…'
            : `Hold to send to wallet · ${amount} SOL`;
  const ready = gate.can && canSign && Boolean(current) && !quoteErr && !sending;

  const send = async () => {
    if (!ready || !wallet.publicKey) return;
    const walletAddress = wallet.publicKey.toBase58();
    const amountSol = amount;
    setSending(true);
    setSendErr(null);
    setChecked(null);
    setStatus('Building and checking the transaction, then opening your wallet…');
    try {
      const r = await signAndSendSolSwap({
        wallet, outputMint: mint, symbol, amountSol, slippageBps,
        onValidated: (c) => {
          setChecked(c);
          setStatus('Checks passed. Approve or reject in your wallet…');
        },
      });
      setStatus(`Confirmed: ${r.signature.slice(0, 12)}…`);
      onBought({ signature: r.signature, explorerUrl: r.explorerUrl, walletAddress, amountSol });
    } catch (e) {
      setStatus(null);
      setChecked(null);
      setSendErr(e instanceof Error ? e.message : String(e));
      onReconcile();
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {current && !checked && (
        <section className="tx-preview" aria-label="What your wallet will be asked to sign">
          <h4>What your wallet will be asked to sign</h4>
          <dl>
            {quotePreview({ amountSol: amount, symbol, decimals, quote: current, slippageBps }).map((r) => (
              <div key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          <p className="help">
            Estimate from a fresh quote. When you hold, the server builds the real transaction and this browser checks it
            before your wallet opens:
          </p>
          <ul className="tx-checks">
            {CHECKED_BEFORE_WALLET.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </section>
      )}
      {checked && (
        <section className="tx-preview tx-checked" aria-label="Checked transaction">
          <h4>✓ Checked transaction</h4>
          <dl>
            {checkedRows(checked, symbol, decimals).map((r) => (
              <div key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          <ul className="tx-checks is-passed">
            {CHECKED_BEFORE_WALLET.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <p className="help">These are the values in the transaction your wallet is showing. If they differ, reject it.</p>
        </section>
      )}
      {quoteErr && gate.can && <div className="cred-msg err">Quote: {quoteErr}</div>}
      {sendErr && <div className="cred-msg err" role="alert">{sendErr}</div>}
      {status && <div className="status-line" role="status">{status}</div>}
      {/* Remount on any change to what would be sent, so an in-progress hold never confirms something else. */}
      <HoldButton key={ready ? quoteKey : 'not-ready'} label={label} disabled={!ready} onComplete={() => void send()} />
      {ready && <p className="help hold-hint">Hold about 1.3 seconds. Your wallet still asks you to approve.</p>}
    </>
  );
}
