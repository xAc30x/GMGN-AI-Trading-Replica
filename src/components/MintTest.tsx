import { useRef, useState } from 'react';
import { fetchMintSafety, type MintSafetyResponse } from '../api';
import { countStatuses, safetyVerdict } from '../safetyChecks';
import { SafetyCheckList } from './SafetyChecks';

/** Solana addresses are base58, 32 to 44 characters. The server validates again. */
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Runs the same server safety check a trade would, for any mint, and shows the result.
 * Read-only: it never quotes, builds, signs or sends anything.
 */
export function MintTest() {
  const [mint, setMint] = useState('');
  const [result, setResult] = useState<MintSafetyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Only the latest scan may update the result, so a slow earlier one can't overwrite it.
  const latest = useRef(0);

  const scan = async () => {
    const m = mint.trim();
    if (!MINT_PATTERN.test(m)) {
      setResult(null);
      setErr('That is not a Solana mint address (base58, 32 to 44 characters).');
      return;
    }
    const id = ++latest.current;
    setLoading(true);
    setErr(null);
    setResult(null);
    try {
      const res = await fetchMintSafety(m);
      if (id === latest.current) setResult(res);
    } catch (e) {
      if (id === latest.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  };

  const verdict = result ? safetyVerdict(result) : null;
  const blockers = result?.blockers ?? [];
  const warnings = result?.warnings ?? [];
  const counts = result ? countStatuses(result.checks) : null;

  return (
    <section className="mint-test" aria-label="Test a mint">
      <h5>Test a mint</h5>
      <p className="setup-note">
        Runs the server's mint check that every trade runs. Price impact is checked later, on the quote. This never trades.
      </p>
      <form
        className="setup-token"
        onSubmit={(e) => {
          e.preventDefault();
          void scan();
        }}
      >
        <input
          value={mint}
          onChange={(e) => setMint(e.target.value)}
          placeholder="Mint address"
          autoComplete="off"
          spellCheck={false}
          aria-label="Mint address to test"
        />
        <button type="submit" className="btn-ghost btn-small" disabled={loading || !mint.trim()}>
          {loading ? 'Scanning…' : 'Scan'}
        </button>
      </form>
      {err && <div className="cred-msg err" role="alert">{err}</div>}
      {result && verdict && counts && (
        <>
          <div className={`verdict verdict-${verdict.toLowerCase()}`} role="status" aria-label={`Test verdict ${verdict}`}>
            <b>{verdict}</b>
            <span>
              {verdict === 'BLOCKED'
                ? blockers[0] ?? 'Failed safety checks'
                : verdict === 'REVIEW'
                  ? `${warnings.length || 'Some'} warning${warnings.length === 1 ? '' : 's'} to review`
                  : 'All checks passed'}
            </span>
            <span className="meta">
              {counts.pass} passed · {counts.warn} warn · {counts.fail} failed
            </span>
          </div>
          {(blockers.length > 1 || warnings.length > 0) && (
            <ul className="verdict-notes">
              {blockers.slice(1).map((b) => <li key={`b-${b}`} className="check-fail">{b}</li>)}
              {warnings.map((w) => <li key={`w-${w}`} className="check-warn">{w}</li>)}
            </ul>
          )}
          <SafetyCheckList checks={result.checks} />
        </>
      )}
    </section>
  );
}
