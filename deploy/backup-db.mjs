#!/usr/bin/env node
/**
 * Consistent backups of the app's databases.
 *
 * Usage: node deploy/backup-db.mjs <data dir> <backup dir> <days to keep>
 *
 * Each run writes a new folder named after the current UTC time, holding a copy of every
 * *.sqlite database (made with SQLite's online backup, so it is safe while the app runs) and
 * every *.json file. Snapshot folders older than <days to keep> are then removed. Only folders
 * this script created (matching its name pattern) are ever removed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function snapshotName(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

function snapshotTime(name) {
  const [day, time] = name.slice(0, -1).split('T');
  return Date.parse(`${day}T${time.replace(/-/g, ':')}Z`);
}

export async function backupDatabases({ dataDir, backupDir, keepDays, now = new Date() }) {
  if (!Number.isInteger(keepDays) || keepDays < 1) throw new Error('days to keep must be a whole number of at least 1');
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite') || f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`No databases found in ${dataDir}`);

  const target = path.join(backupDir, snapshotName(now));
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const source = path.join(dataDir, file);
    const dest = path.join(target, file);
    if (file.endsWith('.sqlite')) {
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        await backup(db, dest);
      } finally {
        db.close();
      }
    } else {
      fs.copyFileSync(source, dest);
    }
  }

  const removed = [];
  for (const name of fs.readdirSync(backupDir)) {
    if (!SNAPSHOT_NAME.test(name)) continue;
    if (now.getTime() - snapshotTime(name) > keepDays * DAY_MS) {
      fs.rmSync(path.join(backupDir, name), { recursive: true });
      removed.push(name);
    }
  }
  return { target, files, removed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dataDir, backupDir, keep] = process.argv.slice(2);
  if (!dataDir || !backupDir || !keep) {
    console.error('Usage: node deploy/backup-db.mjs <data dir> <backup dir> <days to keep>');
    process.exit(2);
  }
  try {
    const { target, files, removed } = await backupDatabases({ dataDir, backupDir, keepDays: Number(keep) });
    console.log(`Backed up ${files.length} file(s) to ${target}; removed ${removed.length} old snapshot(s).`);
  } catch (e) {
    console.error(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
