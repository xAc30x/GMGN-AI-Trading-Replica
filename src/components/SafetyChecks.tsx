import type { MintSafetyCheck } from '../api';
import { countStatuses, groupChecks } from '../safetyChecks';
import type { CheckStatus } from '../safetyChecks';

const GLYPH: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✕' };

/** One small mark per real check, grouped by provider. The count is whatever the server returned. */
export function SafetyPips({ checks }: { checks: MintSafetyCheck[] }) {
  const counts = countStatuses(checks);
  const label = `Safety checks: ${counts.pass} passed, ${counts.warn} warning${counts.warn === 1 ? '' : 's'}, ${counts.fail} failed`;
  return (
    <span className="pips" role="img" aria-label={label} title={label}>
      {groupChecks(checks).map((g) => (
        <span key={g.id} className="pip-group">
          {g.checks.map((c, i) => (
            <span key={`${c.id}-${i}`} className={`pip pip-${c.status}`} />
          ))}
        </span>
      ))}
    </span>
  );
}

/** Full list of checks under provider headings, for the inspector. */
export function SafetyCheckList({ checks }: { checks: MintSafetyCheck[] }) {
  return (
    <div className="check-groups">
      {groupChecks(checks).map((g) => (
        <section key={g.id} className="check-group" aria-label={`${g.label} checks`}>
          <h4>
            {g.label} <span className="meta">{g.checks.length}</span>
          </h4>
          <ul>
            {g.checks.map((c, i) => (
              <li key={`${c.id}-${i}`} className={`check-${c.status}`}>
                <span className="check-glyph" aria-label={c.status}>
                  {GLYPH[c.status]}
                </span>
                <span className="check-detail">{c.detail.replace(/^warn:\s*/i, '')}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
