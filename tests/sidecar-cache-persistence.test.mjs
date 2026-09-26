// Regression coverage for the 2026-09-26 field report's finding B: a
// cachedFetchJson() value computed INSIDE the sidecar (not mirrored from
// the cloud — e.g. the news-digest RPC's live RSS crawl) used to live only
// in sidecar-cache.ts's in-memory `store` Map, so a sidecar restart always
// cold-started it regardless of how recently it had actually been computed.
// sidecar-cache.ts now write-throughs every sidecarCacheSet() into a private
// `local_cache` table in local-cache.db (deliberately separate from
// sync-listener.mjs/local-sync.mjs's own `kv_cache` table — see that file's
// header comment), read back on the next process's first miss.
//
// Each test re-imports the module with a cache-busting query string to get
// a FRESH in-memory `store` — simulating a sidecar restart — while pointing
// at the SAME on-disk LOCAL_SQLITE_PATH, which is the only thing expected
// to actually persist.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE_PATH = path.resolve(import.meta.dirname, '../server/_shared/sidecar-cache.ts');
const MODULE_URL = pathToFileURL(MODULE_PATH).href;

async function importFresh() {
  return import(`${MODULE_URL}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-cache-test-'));
  dbPath = path.join(tmpDir, 'local-cache.db');
  process.env.LOCAL_SQLITE_PATH = dbPath;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LOCAL_SQLITE_PATH;
});

describe('sidecar-cache write-through persistence', { concurrency: 1 }, () => {
  it('a value set before a simulated restart is still served after it, via the SQLite write-through', async () => {
    const before = await importFresh();
    before.sidecarCacheSet('news:digest:v1:full:en', { articles: [1, 2, 3] }, 900);

    const after = await importFresh(); // fresh in-memory store — same on-disk file
    assert.deepEqual(after.sidecarCacheGet('news:digest:v1:full:en'), { articles: [1, 2, 3] });
  });

  it('an entry whose TTL has fully elapsed is a miss after a restart, not served stale forever', async () => {
    const before = await importFresh();
    before.sidecarCacheSet('news:digest:v1:full:en', { articles: ['stale'] }, 10); // MIN_TTL_S clamp
    // Directly rewrite the persisted row's expires_at into the past —
    // waiting out a real 10s TTL would make this test needlessly slow.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE local_cache SET expires_at = 1 WHERE key = 'news:digest:v1:full:en'");
    db.close();

    const after = await importFresh();
    assert.equal(after.sidecarCacheGet('news:digest:v1:full:en'), null);
  });

  it('rehydrates the in-memory store from the persisted row, not just the SQLite read path', async () => {
    const before = await importFresh();
    before.sidecarCacheSet('news:digest:v1:full:en', { articles: ['x'] }, 900);

    const after = await importFresh();
    after.sidecarCacheGet('news:digest:v1:full:en'); // first read after "restart" — pulls from disk
    const stats = after.sidecarCacheStats();
    assert.equal(stats.entries, 1, 'the persisted row should be rehydrated into the in-memory store on read');
  });

  it('does not throw when LOCAL_SQLITE_PATH is unset (persistence silently unavailable)', async () => {
    delete process.env.LOCAL_SQLITE_PATH;
    const mod = await importFresh();
    assert.doesNotThrow(() => mod.sidecarCacheSet('news:digest:v1:full:en', { a: 1 }, 900));
    assert.equal(mod.sidecarCacheGet('some:other:key'), null);
  });

  it('a value never persisted (fresh DB, no writes yet) is a quiet miss, not a thrown error', async () => {
    const mod = await importFresh();
    assert.equal(mod.sidecarCacheGet('news:digest:v1:full:en'), null);
  });
});
