// sidecar-cache.ts loadMirror(): mirror-age source (finding F) and the
// reload gate (finding H) from wmtest's v2.13.16 data-pipeline review.
// Runs under tsx (npm run test:data) — imports the .ts module directly.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE_URL = pathToFileURL(path.resolve(import.meta.dirname, '../server/_shared/sidecar-cache.ts')).href;
const HOUR = 3_600_000;

let tmpDir;
let dbPath;
let mod;

function withDb(fn) {
  const db = new DatabaseSync(dbPath);
  try { return fn(db); } finally { db.close(); }
}

function seed({ rows = [], meta = null } = {}) {
  withDb((db) => {
    db.exec('CREATE TABLE IF NOT EXISTS kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, synced_at INTEGER NOT NULL)');
    for (const [key, value, syncedAt] of rows) {
      db.prepare('INSERT OR REPLACE INTO kv_cache VALUES (?, ?, ?, ?)').run(key, value, 'string', syncedAt);
    }
    if (meta) {
      db.exec('CREATE TABLE IF NOT EXISTS sync_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
      for (const [name, value] of Object.entries(meta)) {
        db.prepare('INSERT OR REPLACE INTO sync_meta VALUES (?, ?)').run(name, String(value));
      }
    }
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-mirror-reload-'));
  dbPath = path.join(tmpDir, 'local-cache.db');
  process.env.LOCAL_SQLITE_PATH = dbPath;
  mod = await import(`${MODULE_URL}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mod.__resetMirrorForTests();
});

afterEach(() => {
  mod.__resetMirrorForTests();
  delete process.env.LOCAL_SQLITE_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mirror age (finding F)', () => {
  it('reports age from the last full reconciliation, not a fresh live-pushed row', () => {
    const now = Date.now();
    seed({
      rows: [['old:key', '"x"', now - 72 * HOUR], ['live:key', '"y"', now]],
      meta: { full_reconcile_at: now - 72 * HOUR, last_reconcile_at: now - 72 * HOUR, last_reconcile_failed_keys: 0 },
    });
    mod.sidecarCacheGet('live:key');
    const age = mod.sidecarMirrorAgeMs();
    assert.ok(age !== null && age > 71 * HOUR, `expected ~72h, got ${age}`);
  });

  it('falls back to the newest row for a mirror with no sync_meta yet', () => {
    const now = Date.now();
    seed({ rows: [['a', '"x"', now - 2 * HOUR], ['b', '"y"', now - HOUR]] });
    mod.sidecarCacheGet('a');
    const age = mod.sidecarMirrorAgeMs();
    assert.ok(age !== null && age >= HOUR && age < 2 * HOUR, `got ${age}`);
  });

  it('reports no age (not a misleading fresh one) when runs happened but none completed', () => {
    const now = Date.now();
    seed({ rows: [['live', '"y"', now]], meta: { last_reconcile_at: now - HOUR, last_reconcile_failed_keys: 3 } });
    mod.sidecarCacheGet('live');
    assert.equal(mod.sidecarMirrorAgeMs(), null);
  });
});

describe('reload gate (finding H)', () => {
  it('does not reload the mirror for a write that only touched local_cache', async () => {
    seed({ rows: [['k', '"v1"', 1]] });
    assert.equal(mod.sidecarCacheGet('k'), 'v1');
    // Sneak a kv_cache change in WITHOUT moving the fingerprint the gate
    // compares (same row count + same synced_at sum) — then touch the file
    // via a local_cache write. If the gate reloaded anyway, we'd see v2.
    withDb((db) => {
      db.prepare('UPDATE kv_cache SET value = ? WHERE key = ?').run('"v2"', 'k');
      db.exec('CREATE TABLE IF NOT EXISTS local_cache (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER, updated_at INTEGER)');
      db.prepare('INSERT INTO local_cache VALUES (?, ?, ?, ?)').run('wt', '{}', Date.now() + 1e6, Date.now());
    });
    await new Promise((r) => setTimeout(r, 5_100)); // past MIRROR_RECHECK_MIN_INTERVAL_MS
    assert.equal(mod.sidecarCacheGet('k'), 'v1');
  });

  it('does reload once kv_cache really changed (after the recheck interval)', async () => {
    seed({ rows: [['k', '"v1"', 1]] });
    assert.equal(mod.sidecarCacheGet('k'), 'v1');
    withDb((db) => db.prepare('UPDATE kv_cache SET value = ?, synced_at = ? WHERE key = ?').run('"v2"', 2, 'k'));
    await new Promise((r) => setTimeout(r, 5_100));
    assert.equal(mod.sidecarCacheGet('k'), 'v2');
  });
});
