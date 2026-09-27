import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UPSERT_SQL, PRUNE_SQL, planReadChunks, pruneToScannedKeys } from '../vscode-extension/sidecar/local-sync.mjs';

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

// Prune is driven by the SCAN key list, not by which value reads succeeded
// (wmtest v2.13.16 review, finding E — a deleted-upstream key used to be
// served forever whenever any chunk of the run failed).
describe('pruneToScannedKeys (scan-set prune)', () => {
  const insert = () => db.prepare('INSERT INTO kv_cache VALUES (?, ?, ?, ?)');

  it('deletes rows not in the scan set, keeping scanned keys even if this run never re-read them', () => {
    const scanStartedAt = 100;
    insert().run('keyA', 'a', 'string', scanStartedAt - 10); // scanned; read failed this run
    insert().run('keyB', 'b', 'string', scanStartedAt - 10); // scanned
    insert().run('gone', 'x', 'string', scanStartedAt - 10); // deleted upstream
    const deleted = pruneToScannedKeys(db, ['keyA', 'keyB'], scanStartedAt);
    assert.equal(deleted, 1);
    const remaining = db.prepare('SELECT key FROM kv_cache ORDER BY key').all().map((r) => r.key);
    assert.deepEqual(remaining, ['keyA', 'keyB']);
  });

  it('keeps a row written (live push) after the scan started, even if the scan did not see it', () => {
    insert().run('pushedMidRun', 'live', 'string', 150);
    assert.equal(pruneToScannedKeys(db, ['other'], 100), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kv_cache').get().n, 1);
  });

  it('exposes the SQL it runs (temp keep-table + guarded delete)', () => {
    assert.match(PRUNE_SQL, /NOT IN \(SELECT key FROM scan_keep\)/);
    assert.match(PRUNE_SQL, /synced_at < \?/);
  });
});

// Byte-aware chunking (finding D): a fixed 100-key chunk containing a 1.3 MB
// key could never finish within the per-request timeout on a slow link.
describe('planReadChunks', () => {
  const e = (key) => ({ key, type: 'string' });

  it('isolates a key larger than the byte budget into its own chunk', () => {
    const sizes = { big: 1_300_000, a: 1000, b: 1000 };
    const chunks = planReadChunks([e('a'), e('big'), e('b')], (k) => sizes[k]);
    assert.deepEqual(chunks.map((c) => c.entries.map((x) => x.key)), [['a'], ['big'], ['b']]);
    assert.equal(chunks[1].bytes, 1_300_000);
  });

  it('still caps a chunk of tiny keys at 100 keys', () => {
    const entries = Array.from({ length: 250 }, (_, i) => e(`k${i}`));
    const chunks = planReadChunks(entries, () => 10);
    assert.deepEqual(chunks.map((c) => c.entries.length), [100, 100, 50]);
  });

  it('packs by bytes, assuming a default size for keys not yet in the mirror', () => {
    const entries = Array.from({ length: 10 }, (_, i) => e(`k${i}`));
    const chunks = planReadChunks(entries, () => 100 * 1024);
    // 256 KB budget → 2 × 100 KB per chunk.
    assert.deepEqual(chunks.map((c) => c.entries.length), [2, 2, 2, 2, 2]);
    const unknown = planReadChunks([e('x')], () => undefined);
    assert.ok(unknown[0].bytes > 0);
  });
});
