import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the real client module (type-only imports are erased), as livePreflight.test.js does.
const source = readFileSync(new URL('../../src/safetyChecks.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
} });
const { checkGroup, checkStatus, groupChecks, countStatuses, safetyVerdict } =
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
