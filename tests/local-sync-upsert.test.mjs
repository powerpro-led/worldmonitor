import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UPSERT_SQL, PRUNE_SQL } from '../vscode-extension/sidecar/local-sync.mjs';

// Exercises the exact SQL local-sync.mjs's full rebuild now runs directly
// against the LIVE local-cache.db (see that file's own header comment for
// why it no longer builds a scratch file and renames it in) — a real
// node:sqlite database, not a mock, since the previous two fix attempts for
// this exact Windows bug (a retry ladder, then forcing rollback-journal
// mode) each looked correct and each failed on real hardware. This doesn't
// touch Windows-specific rename/handle behavior at all (that's the point of
// the rewrite), but the freshness-guard and prune logic below is new and
// needs to be right regardless of platform.

let tmpDir;
let dbPath;
let db;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-sync-upsert-test-'));
  dbPath = path.join(tmpDir, 'local-cache.db');
  db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, synced_at INTEGER NOT NULL)');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('UPSERT_SQL freshness guard', () => {
  it('keeps a row sync-listener already wrote fresher than this scan, instead of reverting it', () => {
    const upsert = db.prepare(UPSERT_SQL);
    upsert.run('keyA', 'fresh-from-live-push', 'string', 200);
    upsert.run('keyA', 'stale-from-scan', 'string', 100); // a slow rebuild that started earlier
    const row = db.prepare('SELECT value, synced_at FROM kv_cache WHERE key = ?').get('keyA');
    assert.equal(row.value, 'fresh-from-live-push');
    assert.equal(row.synced_at, 200);
  });

  it('applies the update when the new value is not older (equal counts as not older)', () => {
    const upsert = db.prepare(UPSERT_SQL);
    upsert.run('keyA', 'first', 'string', 100);
    upsert.run('keyA', 'second', 'string', 100);
    const row = db.prepare('SELECT value FROM kv_cache WHERE key = ?').get('keyA');
    assert.equal(row.value, 'second');
  });

  it('applies the update when the new value is strictly newer', () => {
    const upsert = db.prepare(UPSERT_SQL);
    upsert.run('keyA', 'old', 'string', 100);
    upsert.run('keyA', 'new', 'string', 150);
    const row = db.prepare('SELECT value, synced_at FROM kv_cache WHERE key = ?').get('keyA');
    assert.equal(row.value, 'new');
    assert.equal(row.synced_at, 150);
  });

  it('inserts a brand-new key unconditionally (no existing row to guard against)', () => {
    const upsert = db.prepare(UPSERT_SQL);
    upsert.run('keyNew', 'value', 'string', 1);
    const row = db.prepare('SELECT value FROM kv_cache WHERE key = ?').get('keyNew');
    assert.equal(row.value, 'value');
  });
});

describe('PRUNE_SQL watermark delete', () => {
  it('deletes only rows older than this run, keeping everything the run touched', () => {
    const upsert = db.prepare(UPSERT_SQL);
    const syncedAt = 100;
    // keyA and keyB are admitted this run, both stamped with syncedAt.
    upsert.run('keyA', 'a', 'string', syncedAt);
    upsert.run('keyB', 'b', 'string', syncedAt);
    // keyC is a leftover from a prior run and is no longer admitted.
    db.prepare('INSERT INTO kv_cache VALUES (?, ?, ?, ?)').run('keyC', 'orphan', 'string', syncedAt - 50);
    // keyD was pushed live, fresher than this run — must survive even though
    // it was never touched by this run's upsert loop at all.
    db.prepare('INSERT INTO kv_cache VALUES (?, ?, ?, ?)').run('keyD', 'live', 'string', syncedAt + 50);

    const deleted = db.prepare(PRUNE_SQL).run(syncedAt).changes;
    assert.equal(deleted, 1);

    const remaining = db.prepare('SELECT key FROM kv_cache ORDER BY key').all().map((r) => r.key);
    assert.deepEqual(remaining, ['keyA', 'keyB', 'keyD']);
  });

  it('deletes nothing when every row is at least as fresh as this run', () => {
    const upsert = db.prepare(UPSERT_SQL);
    upsert.run('keyA', 'a', 'string', 100);
    const deleted = db.prepare(PRUNE_SQL).run(100).changes;
    assert.equal(deleted, 0);
  });
});
