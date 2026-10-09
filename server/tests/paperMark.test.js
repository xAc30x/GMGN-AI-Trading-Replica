import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/pnl.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
const { paperMarkView, PAPER_MARK_FRESH_MS } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const now = 1_000_000;
const cost = '10000000'; // 0.01 SOL

test('a rising position shows a plus sign, the SOL gain and a green tone', () => {
  const view = paperMarkView({ at: now - 5000, netLamports: '10321000', pnlPct: 3.21 }, cost, null, now);
  assert.equal(view.text, '+3.21%');
  assert.equal(view.detail, '+0.000321 SOL · worth 0.010321 SOL · 5s ago');
  assert.equal(view.tone, 'pos');
});

test('a falling position shows a minus sign, the SOL loss and a red tone', () => {
  const view = paperMarkView({ at: now - 1000, netLamports: '9800000', pnlPct: -2 }, cost, null, now);
  assert.equal(view.text, '-2.00%');
  assert.equal(view.detail, '-0.000200 SOL · worth 0.009800 SOL · 1s ago');
  assert.equal(view.tone, 'neg');
});

test('exactly break-even has no colour', () => {
  assert.equal(paperMarkView({ at: now, netLamports: cost, pnlPct: 0 }, cost, null, now).tone, null);
});

test('an old mark is labelled out of date and loses its colour', () => {
  const view = paperMarkView({ at: now - PAPER_MARK_FRESH_MS - 1000, netLamports: '10500000', pnlPct: 5 }, cost, null, now);
  assert.equal(view.text, 'Price out of date');
  assert.equal(view.detail, 'Last +5.00% · 46s ago');
  assert.equal(view.tone, null);
});

test('a mark at the freshness limit still counts as current', () => {
  assert.equal(paperMarkView({ at: now - PAPER_MARK_FRESH_MS, netLamports: cost, pnlPct: 0.5 }, cost, null, now).text, '+0.50%');
});

test('a quote error makes even a recent mark out of date', () => {
  const view = paperMarkView({ at: now - 1000, netLamports: '10500000', pnlPct: 5 }, cost, 'Quote failed', now);
  assert.equal(view.text, 'Price out of date');
  assert.equal(view.tone, null);
});

test('no mark yet says it is waiting and shows any error', () => {
  assert.equal(paperMarkView(null, cost, null, now).text, 'Waiting for first price');
  assert.equal(paperMarkView(null, cost, 'Quote failed', now).detail, 'Quote failed');
});
