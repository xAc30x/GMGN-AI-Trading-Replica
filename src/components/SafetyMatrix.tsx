import type { WatchlistScanItem } from '../api';
import { buildMatrix, type CheckStatus } from '../safetyChecks';

interface Props {
  items: { mint: string; symbol: string; scan: WatchlistScanItem }[];
  /** Watchlist tokens that have no scan result yet. */
  unscanned: number;
  selectedMint?: string | null;
  onSelect?: (mint: string) => void;
}

const GLYPH: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✕' };
const GROUP_NAMES = { onchain: 'On-chain', rugcheck: 'RugCheck', goplus: 'GoPlus', other: 'Other' } as const;

/** Every check for every watchlist token at once, plus a list of every warning and failure. */
export function SafetyMatrix({ items, unscanned, selectedMint, onSelect }: Props) {
  const { columns, rows, why } = buildMatrix(items);
  if (rows.length === 0) {
    return <p className="help matrix-empty">No scan results yet. Add a mint or press Rescan.</p>;
  }
  const groups = columns.reduce<{ group: keyof typeof GROUP_NAMES; span: number }[]>((acc, c) => {
    const last = acc[acc.length - 1];
    if (last && last.group === c.group) last.span += 1;
    else acc.push({ group: c.group, span: 1 });
    return acc;
  }, []);

  return (
    <div className="matrix">
      <div className="table-wrap">
        <table className="matrix-table" aria-label="Safety matrix">
          <thead>
            <tr>
              <th rowSpan={2}>Token</th>
              {groups.map((g, i) => (
                <th key={`${g.group}-${i}`} colSpan={g.span} className="matrix-group">{GROUP_NAMES[g.group]}</th>
              ))}
              <th rowSpan={2}>Verdict</th>
            </tr>
            <tr>
              {columns.map((c) => (
                <th key={c.id} className="matrix-col" title={c.id}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.mint} className={selectedMint === r.mint ? 'is-selected' : undefined}>
                <th scope="row">
                  {onSelect ? (
                    <button type="button" className="row-select" aria-pressed={selectedMint === r.mint} onClick={() => onSelect(r.mint)}>
                      <span className="sym">{r.symbol}</span>
                    </button>
                  ) : (
                    <span className="sym">{r.symbol}</span>
                  )}
                </th>
                {columns.map((c) => {
                  const s = r.cells[c.id];
                  return (
                    <td key={c.id} className={`matrix-cell ${s ? `cell-${s}` : 'cell-none'}`} aria-label={`${c.label}: ${s ?? 'not run'}`}>
                      {s ? GLYPH[s] : '·'}
                    </td>
                  );
                })}
                <td className={`matrix-verdict verdict-text-${r.verdict.toLowerCase()}`}>{r.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="matrix-legend">
        ✓ pass · ! warn, acknowledge to trade · ✕ block · · not run for this token
        {unscanned > 0 && <> · {unscanned} watchlist token{unscanned === 1 ? '' : 's'} not scanned yet</>}
      </p>
      <h3 className="matrix-why-title">Why: every warning and failure on the watchlist</h3>
      {why.length === 0 ? (
        <p className="help">Every check passed.</p>
      ) : (
        <ul className="matrix-why" aria-label="Warnings and failures">
          {why.map((w, i) => (
            <li key={`${w.mint}-${i}`} className={`check-${w.status}`}>
              <span className="check-glyph" aria-label={w.status}>{GLYPH[w.status]}</span>
              <span className="sym">{w.symbol}</span>
              <span className="meta">{w.group}</span>
              <span className="check-detail">{w.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
