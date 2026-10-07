import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabases, snapshotName } from '../../deploy/backup-db.mjs';

test('backup copies live WAL databases and JSON files, then prunes only old snapshots', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(backupDir);

  // Keep the database open in WAL mode, as the running app does, with rows not yet checkpointed.
  const live = new DatabaseSync(path.join(dataDir, 'portfolio.sqlite'));
  t.after(() => live.close());
  live.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');");
  fs.writeFileSync(path.join(dataDir, 'broadcast-journal.json'), '{"entries":[]}');
  fs.writeFileSync(path.join(dataDir, 'notes.txt'), 'not a database');

  const now = new Date('2026-10-06T03:30:00Z');
  const stale = snapshotName(new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000));
  const recent = snapshotName(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
  for (const dir of [stale, recent, 'keep-me']) fs.mkdirSync(path.join(backupDir, dir));

  const result = await backupDatabases({ dataDir, backupDir, keepDays: 14, now });
  assert.deepEqual(result.files, ['broadcast-journal.json', 'portfolio.sqlite']);
  assert.deepEqual(result.removed, [stale]);
  assert.deepEqual(fs.readdirSync(backupDir).sort(), ['2026-10-06T03-30-00Z', 'keep-me', recent].sort());

  const copy = new DatabaseSync(path.join(result.target, 'portfolio.sqlite'), { readOnly: true });
  t.after(() => copy.close());
  assert.deepEqual(copy.prepare('SELECT v FROM t').all().map(r => r.v), ['kept']);
  assert.equal(fs.readFileSync(path.join(result.target, 'broadcast-journal.json'), 'utf8'), '{"entries":[]}');
});

test('backup refuses bad settings and an empty data folder', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-backup-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(backupDatabases({ dataDir: root, backupDir: root, keepDays: 0 }), /at least 1/);
  await assert.rejects(backupDatabases({ dataDir: root, backupDir: root, keepDays: 14 }), /No databases found/);
});
