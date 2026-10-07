import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the real client module (type-only imports are erased), as livePreflight.test.js does.
const source = readFileSync(new URL('../../src/safetyChecks.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
} });
const { checkGroup, checkStatus, groupChecks, countStatuses, safetyVerdict, buildMatrix } =
  await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

// Shapes copied from what server/mintSafety.js and server/rugScanner.js push.
const checks = [
  { id: 'exists', ok: true, detail: 'Mint account found' },
  { id: 'freezeAuthority', ok: true, detail: 'No freeze authority' },
  { id: 'mintAuthority', ok: true, detail: 'Warn: mint authority still set (Abcd…)' },
  { id: 'goplus:mintable', ok: true, detail: 'Warn: GoPlus mintable=true', level: 'warn' },
  { id: 'rugged', ok: true, detail: 'Not marked rugged', level: 'info' },
  { id: 'risk:Low liquidity', ok: false, detail: 'Low liquidity', level: 'danger' },
  { id: 'somethingNew', ok: true, detail: 'unknown provider' },
];

test('checks are grouped by the provider that produced them', () => {
  assert.equal(checkGroup('supply'), 'onchain');
  assert.equal(checkGroup('rugScore'), 'rugcheck');
  assert.equal(checkGroup('risk:Top 10 holders'), 'rugcheck');
  assert.equal(checkGroup('goplus'), 'goplus');
  assert.equal(checkGroup('goplus:freezable'), 'goplus');
  assert.equal(checkGroup('somethingNew'), 'other');
});

test('a passed check that the server marked as a warning counts as a warning', () => {
  assert.equal(checkStatus(checks[0]), 'pass');
  assert.equal(checkStatus(checks[2]), 'warn'); // "Warn:" prefix, no level (on-chain)
  assert.equal(checkStatus(checks[3]), 'warn'); // level: 'warn'
  assert.equal(checkStatus(checks[5]), 'fail');
});

test('groups come in a fixed order, keep server order inside, and skip empty groups', () => {
  const groups = groupChecks(checks);
  assert.deepEqual(groups.map(g => g.label), ['On-chain', 'RugCheck', 'GoPlus', 'Other']);
  assert.deepEqual(groups[0].checks.map(c => c.id), ['exists', 'freezeAuthority', 'mintAuthority']);
  assert.deepEqual(groups[1].checks.map(c => c.status), ['pass', 'fail']);
  // Every check is shown exactly once: the real count, not a fixed number.
  assert.equal(groups.reduce((n, g) => n + g.checks.length, 0), checks.length);
  assert.deepEqual(groupChecks([{ id: 'supply', ok: true, detail: 'supply=1' }]).map(g => g.id), ['onchain']);
});

test('status counts match the checks', () => {
  assert.deepEqual(countStatuses(checks), { pass: 4, warn: 2, fail: 1 });
});

test('verdict is BLOCKED on any blocker, REVIEW on warnings, PASS otherwise', () => {
  const clean = [{ id: 'exists', ok: true, detail: 'Mint account found' }];
  assert.equal(safetyVerdict({ ok: true, blockers: [], checks: clean }), 'PASS');
  assert.equal(safetyVerdict({ ok: true, blockers: [], warnings: ['GoPlus: mint authority still active'], checks: clean }), 'REVIEW');
  assert.equal(safetyVerdict({ ok: true, blockers: [], checks: [checks[2]] }), 'REVIEW');
  assert.equal(safetyVerdict({ ok: false, blockers: [] }), 'BLOCKED');
  assert.equal(safetyVerdict({ ok: true, blockers: ['Freeze authority is set'] }), 'BLOCKED');
});

test('one unavailable rug provider is a warning, as the server rates it; other failures still block', () => {
  assert.equal(checkStatus({ id: 'rugcheck', ok: false, detail: 'RugCheck unavailable: timeout', level: 'warn' }), 'warn');
  assert.equal(checkStatus({ id: 'goplus', ok: false, detail: 'GoPlus unavailable: 500', level: 'warn' }), 'warn');
  assert.equal(checkStatus({ id: 'freezeAuthority', ok: false, detail: 'Freeze authority set' }), 'fail');
  assert.equal(checkStatus({ id: 'rugged', ok: false, detail: 'marked rugged', level: 'danger' }), 'fail');
});

test('matrix columns are the checks the server ran; missing checks stay empty', () => {
  const a = { mint: 'A', symbol: 'AAA', scan: { mint: 'A', ok: true, blockers: [], checks: [
    { id: 'exists', ok: true, detail: 'Mint account found' },
    { id: 'risk:Low liquidity', ok: true, detail: 'Warn: Low liquidity', level: 'warn' },
    { id: 'risk:Mutable metadata', ok: true, detail: 'Mutable metadata', level: 'info' },
    { id: 'goplus:mintable', ok: true, detail: 'Warn: GoPlus mintable=true', level: 'warn' },
  ] } };
  const b = { mint: 'B', symbol: 'BBB', scan: { mint: 'B', ok: false, blockers: ['Freeze authority is set'], checks: [
    { id: 'freezeAuthority', ok: false, detail: 'Freeze authority set (Frz1…)' },
    { id: 'exists', ok: true, detail: 'Mint account found' },
  ] } };
  const { columns, rows, why } = buildMatrix([a, b]);
  assert.deepEqual(columns.map(c => c.id), ['exists', 'freezeAuthority', 'risk', 'goplus:mintable']);
  // Named RugCheck risks fold into one column holding the worst status.
  assert.equal(rows[0].cells.risk, 'warn');
  assert.equal(rows[0].cells.freezeAuthority, undefined);
  assert.equal(rows[1].cells.freezeAuthority, 'fail');
  assert.deepEqual(rows.map(r => r.verdict), ['REVIEW', 'BLOCKED']);
  // Failures are listed before warnings; passes are not listed.
  assert.deepEqual(why.map(w => [w.symbol, w.status, w.detail]), [
    ['BBB', 'fail', 'Freeze authority set (Frz1…)'],
    ['AAA', 'warn', 'Low liquidity'],
    ['AAA', 'warn', 'GoPlus mintable=true'],
  ]);
});
