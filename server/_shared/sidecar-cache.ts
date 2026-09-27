/**
 * In-memory TTL + LRU cache for the Tauri sidecar, backed on a miss by (in
 * order) this file's OWN on-disk write-through table, then a read-only
 * mirror of the local SQLite sync cache
 * (vscode-extension/sidecar/local-cache.db's `kv_cache` table, populated by
 * `npm run local-sync` pulling directly from Upstash — see that script's
 * header comment for the full pipeline). Activated only when
 * LOCAL_API_MODE === 'tauri-sidecar'. No top-level side effects; the
 * in-memory sweep timer starts lazily on first write, and the mirror is
 * loaded lazily on first read miss, not at module load.
 *
 * The write-through table (`local_cache`, this file's own — see
 * persistLocalCacheEntry()/readPersistedLocalCacheEntry() below) exists for
 * data this process computes ITSELF rather than receiving from the cloud
 * mirror: a real 2026-09-26 field report found the news-digest RPC (dozens
 * of RSS feeds crawled live, inside this same sidecar process, on a cache
 * miss — see server/worldmonitor/news/v1/list-feed-digest.ts) cold-starting
 * for 28-40s on EVERY sidecar restart, because the in-memory `store` below
 * is this cache's only backing and is obviously empty right after a
 * restart, no matter how recently the value had actually been computed
 * before that restart. A deliberately SEPARATE table from `kv_cache`, not a
 * shared one — `kv_cache` is written by two OTHER processes
 * (sync-listener.mjs, local-sync.mjs) on a schedule this file doesn't
 * control, and its own header comment documents it as "read-only... static
 * for the process's lifetime," with no per-row TTL concept at all. Reusing
 * it here would mean either teaching those two files' schema/rescan logic
 * about a foreign row shape they don't own, or serving a locally-computed
 * value forever past its real TTL after a restart (the mirror-read path has
 * no expiry check). A private table sidesteps both: only this file ever
 * touches it, and every row explicitly carries the expiry the ORIGINAL
 * `cachedFetchJson()` call asked for, checked on every read.
 *
 * `node:sqlite` is loaded via `process.getBuiltinModule` rather than a
 * static `import`/`require('node:sqlite')` — this file is transitively
 * reachable from `api/*.ts` Vercel Edge handlers (via redis.ts's dynamic
 * `import('./sidecar-cache')`), and a static reference to a Node-only
 * built-in would risk edge-bundler resolution failures even though this
 * code path only ever actually runs inside the plain Node process running
 * `local-api-server.mjs` in tauri-sidecar mode.
 */

import { unwrapEnvelope } from './seed-envelope';

const MAX_ENTRIES = 500;
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_SINGLE_VALUE_BYTES = 2 * 1024 * 1024; // 2 MB
const MIN_TTL_S = 10;
const MAX_TTL_S = 86_400;
const SWEEP_INTERVAL_MS = 60_000;

interface CacheEntry {
  value: string; // JSON-stringified
  expiresAt: number;
  size: number;
}

const store = new Map<string, CacheEntry>();
let totalBytes = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

let hitCount = 0;
let missCount = 0;

function startSweepIfNeeded(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of store) {
      if (entry.expiresAt <= now) {
        totalBytes -= entry.size;
        store.delete(k);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Don't hold the process open
  if (typeof sweepTimer === 'object' && 'unref' in sweepTimer) {
    sweepTimer.unref();
  }
}

function evictLRU(incomingSize = 0): void {
  // Collect keys to evict first, then delete (avoids mutating Map during iteration).
  // Ensure headroom for an incoming write, not only current occupancy.
  const keysToEvict: string[] = [];
  for (const [k, entry] of store) {
    const nextEntryCount = store.size - keysToEvict.length + 1;
    const nextTotalBytes = totalBytes + incomingSize;
    if (nextEntryCount <= MAX_ENTRIES && nextTotalBytes <= MAX_BYTES) break;
    keysToEvict.push(k);
    totalBytes -= entry.size;
  }
  for (const k of keysToEvict) store.delete(k);
}

type MirrorRow = { key: string; value: string; type: string; synced_at: number };
type MirrorEntry = { value: string; type: string };

/**
 * scripts/build-sidecar-handlers.mjs esbuild-bundles this module SEPARATELY
 * into each of the ~34 api/{domain}/v1/[rpc].js domain handlers (each is
 * its own entry point) — a plain module-level `let mirror` would give every
 * bundle its own private copy, so local-api-server.mjs's single Node
 * process ends up loading and holding the full mirror once per domain
 * actually hit, not once total (confirmed live: "[sidecar-cache] loaded
 * 1109 keys" repeated ~11x for a handful of RPC calls). globalThis is the
 * one thing genuinely shared across those separately-bundled copies within
 * one process.
 */
const MIRROR_GLOBAL_KEY = Symbol.for('worldmonitor.sidecarCache.mirror');
// mtime of local-cache.db at the moment it was last loaded into the mirror
// above — same globalThis treatment as the mirror itself, for the same
// reason (shared across ~34 separately-bundled copies of this module in one
// process). Lets loadMirror() notice when vscode-extension/sidecar/
// local-sync.mjs has rewritten the file (see its automated periodic runs in
// local-api-server.mjs) without needing a process restart — see loadMirror().
const MIRROR_MTIME_GLOBAL_KEY = Symbol.for('worldmonitor.sidecarCache.mirrorMtimeMs');
// kv_cache content fingerprint at last load + when it was last checked —
// see loadMirror()'s reload gate (finding H). Same globalThis treatment.
const MIRROR_FINGERPRINT_GLOBAL_KEY = Symbol.for('worldmonitor.sidecarCache.mirrorFingerprint');
const MIRROR_CHECKED_AT_GLOBAL_KEY = Symbol.for('worldmonitor.sidecarCache.mirrorCheckedAtMs');
type GlobalWithMirror = typeof globalThis & {
  [MIRROR_GLOBAL_KEY]?: Map<string, MirrorEntry>;
  [MIRROR_MTIME_GLOBAL_KEY]?: number;
  [MIRROR_FINGERPRINT_GLOBAL_KEY]?: string;
  [MIRROR_CHECKED_AT_GLOBAL_KEY]?: number;
};

/**
 * Minimum gap between content checks once the file's mtime has moved. The
 * mtime changes on EVERY write to local-cache.db — each sync-listener.mjs
 * row, each local-sync.mjs batch, and this module's own local_cache
 * write-through — and each used to trigger a full reload of the whole
 * (~20 MB, ~4k-row) mirror plus a "changed on disk — reloading" log line
 * (wmtest v2.13.16 review, finding H). A live push now reaches readers
 * within this window instead of instantly.
 */
const MIRROR_RECHECK_MIN_INTERVAL_MS = 5_000;

/**
 * Age of the mirror, measured when it was loaded: time since local-sync.mjs's
 * last FULL reconciliation (sync_meta), or — for a mirror that predates
 * sync_meta — the newest row's synced_at (see readReconcileMeta()). Null
 * until loaded, if the table was empty, or if reconciliations have run but
 * none completed.
 *
 * `synced_at` had been written by local-sync.mjs since the mirror existed
 * and read by nothing — the loader did not even SELECT it. That is how a
 * four-day-old mirror looked exactly like a fresh one: nothing automates
 * `npm run local-sync`, so when it broke, every panel kept serving a
 * point-in-time snapshot with no indication anywhere that it had frozen.
 *
 * This does not (and should not) expire rows. Serving a stale mirror is the
 * whole point of an offline operator cache, and the mirror is deliberately
 * static for the process's lifetime — see loadMirror() below. The gap being
 * closed here is purely that its age was invisible.
 */
let mirrorAge: number | null = null;

const STALE_MIRROR_WARN_MS = 24 * 60 * 60 * 1000;

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Age of the loaded mirror in ms, or null if it has not been loaded or is empty. */
export function sidecarMirrorAgeMs(): number | null {
  return mirrorAge;
}

type SqliteDb = { prepare(sql: string): { all(): unknown[]; get(...args: unknown[]): unknown; run(...args: unknown[]): unknown }; exec(sql: string): void; close(): void };
type SqliteCtor = new (path: string, opts?: { readOnly?: boolean }) => SqliteDb;

/** Shared node:sqlite loader — see this file's header comment for why this is dynamic, not a static import. */
function getSqliteCtor(): SqliteCtor | null {
  const sqlite = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite') as
    | { DatabaseSync: SqliteCtor }
    | undefined;
  return sqlite?.DatabaseSync ?? null;
}

const LOCAL_CACHE_DDL = `
  CREATE TABLE IF NOT EXISTS local_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

/**
 * Best-effort write-through for a value this process just computed itself.
 * Opens local-cache.db fresh for one write, then closes it — same
 * open/write/close-per-call discipline as sync-listener.mjs's own
 * upsertRow() (see that function's comment for why: DELETE journal mode
 * forced, no persistent handle held between calls, since this file shares
 * the same physical .db file with two other processes that write to their
 * OWN table in it). Never throws — a failed persist just means this
 * process falls back to a cold recompute on its next restart, exactly
 * today's behavior, not a regression.
 */
function persistLocalCacheEntry(key: string, json: string, expiresAt: number): void {
  const dbPath = process.env.LOCAL_SQLITE_PATH;
  if (!dbPath) return;
  const Sqlite = getSqliteCtor();
  if (!Sqlite) return;
  try {
    const db = new Sqlite(dbPath);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
      db.exec(LOCAL_CACHE_DDL);
      db.prepare(
        'INSERT INTO local_cache (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at',
      ).run(key, json, expiresAt, Date.now());
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[sidecar-cache] failed to persist "${key}" to local_cache (non-fatal):`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Reads this process's own persisted write-through row for `key`, if any
 * and not yet past the expiry it was written with. Unlike the read-only
 * `kv_cache` mirror (loadMirror(), no per-row TTL at all), an expired row
 * here is treated as an honest miss — serving it anyway would silently
 * defeat the TTL contract every cachedFetchJson() caller already relies on
 * elsewhere (Redis-backed or not), just because a restart happened to land
 * past it.
 */
function readPersistedLocalCacheEntry(key: string): { value: string; expiresAt: number } | null {
  const dbPath = process.env.LOCAL_SQLITE_PATH;
  if (!dbPath) return null;
  const Sqlite = getSqliteCtor();
  if (!Sqlite) return null;
  try {
    const db = new Sqlite(dbPath, { readOnly: true });
    try {
      // No db.exec(LOCAL_CACHE_DDL) here on purpose — this connection is
      // read-only, and issuing CREATE TABLE (even IF NOT EXISTS) over a
      // read-only handle throws "attempt to write a readonly database" the
      // moment the table genuinely doesn't exist yet (verified: it's a
      // no-op, not an error, when the table already exists — SQLite only
      // needs write access for the actual creation). The table only ever
      // needs creating from persistLocalCacheEntry()'s read-write handle;
      // "no such table" here just means nothing has been persisted yet,
      // handled below as a quiet miss, not logged as a real failure.
      const row = db.prepare('SELECT value, expires_at FROM local_cache WHERE key = ?').get(key) as
        | { value: string; expires_at: number }
        | undefined;
      if (!row || row.expires_at <= Date.now()) return null;
      return { value: row.value, expiresAt: row.expires_at };
    } finally {
      db.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Both expected, quiet misses on a genuinely first-ever run: the table
    // not existing yet (nothing persisted this process lifetime), or the
    // whole .db file not existing yet (no sync-listener.mjs/local-sync.mjs
    // write and no prior sidecarCacheSet() write-through either).
    if (!/no such table|unable to open database file/i.test(message)) {
      console.warn(`[sidecar-cache] failed to read "${key}" from local_cache (non-fatal):`, message);
    }
    return null;
  }
}

function statMtimeMs(dbPath: string): number | null {
  // node:fs loaded the same way node:sqlite is below (process.getBuiltinModule
  // rather than a static import) — this file is transitively reachable from
  // api/*.ts Vercel Edge handlers, and a static reference to a Node-only
  // built-in would risk edge-bundler resolution failures.
  const fs = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:fs') as
    | { statSync: (path: string) => { mtimeMs: number } }
    | undefined;
  if (!fs) return null;
  try {
    return fs.statSync(dbPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Loads the entire local-cache.db `kv_cache` table into memory, re-reading
 * it whenever the file's mtime has changed since the last load (a stat() is
 * far cheaper than the full-table read, so checking it on every call is
 * fine). A full-table read (not a per-key SQLite query per miss) because the
 * mirror is small (low thousands of rows at most, per local-sync.mjs's own
 * domain scope).
 *
 * Was unconditionally cached for the process's lifetime until session 38 —
 * that made sense when `npm run local-sync` was a manual, rarely-run
 * command (a resync really did need a restart to matter). Now that
 * local-api-server.mjs runs it on an automatic timer (see startLocalSync()
 * there), a live process needs to actually notice the file changing under
 * it, or the automation is invisible from inside an already-running sidecar.
 */
type KvDb = { prepare(sql: string): { all(): unknown[]; get(): unknown }; close(): void };

/**
 * Cheap change detector for kv_cache alone — row count + sum of synced_at,
 * no values read. Every kv_cache upsert or delete moves it; writes to the
 * sibling local_cache table don't. Null if it can't be read.
 */
function kvCacheFingerprint(db: KvDb): string | null {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(synced_at), 0) AS s FROM kv_cache').get() as
      | { n: number | bigint; s: number | bigint }
      | undefined;
    return row ? `${row.n}:${row.s}` : null;
  } catch {
    return null;
  }
}

function openMirrorDb(dbPath: string): KvDb | null {
  const sqlite = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite') as
    | { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => KvDb }
    | undefined;
  return sqlite ? new sqlite.DatabaseSync(dbPath, { readOnly: true }) : null;
}

/**
 * Mirror age for logging/staleness (finding F). Prefers local-sync.mjs's
 * recorded completion of the last FULL reconciliation (sync_meta, see
 * kv-cache-schema.mjs) over the newest row's synced_at — any one live-pushed
 * row used to make a days-old mirror read "synced 0m ago" and suppress the
 * 24h warning. Falls back to the newest row only for a mirror that predates
 * sync_meta (until its next reconciliation writes it).
 */
function readReconcileMeta(db: KvDb): { fullAt: number | null; lastAt: number | null; lastFailedKeys: number } | null {
  try {
    const rows = db.prepare('SELECT name, value FROM sync_meta').all() as { name: string; value: string }[];
    const byName = new Map(rows.map((r) => [r.name, r.value]));
    const num = (name: string) => (byName.has(name) ? Number(byName.get(name)) : null);
    return { fullAt: num('full_reconcile_at'), lastAt: num('last_reconcile_at'), lastFailedKeys: num('last_reconcile_failed_keys') ?? 0 };
  } catch {
    return null; // no sync_meta table yet — a pre-2026-09-26 mirror
  }
}

function loadMirror(): Map<string, MirrorEntry> {
  const g = globalThis as GlobalWithMirror;
  const dbPath = process.env.LOCAL_SQLITE_PATH;
  const existing = g[MIRROR_GLOBAL_KEY];

  if (existing) {
    if (!dbPath) return existing;
    const currentMtimeMs = statMtimeMs(dbPath);
    // Can't stat it (deleted, permissions, no node:fs) — keep serving what
    // we have rather than discard a working mirror over a transient error.
    if (currentMtimeMs === null || currentMtimeMs === g[MIRROR_MTIME_GLOBAL_KEY]) return existing;
    // Finding H: the file moved, but most moves are a single live row or a
    // local_cache write-through. Check at most every few seconds, and only
    // do the full reload when kv_cache's own fingerprint actually changed.
    const now = Date.now();
    if (now - (g[MIRROR_CHECKED_AT_GLOBAL_KEY] ?? 0) < MIRROR_RECHECK_MIN_INTERVAL_MS) return existing;
    g[MIRROR_CHECKED_AT_GLOBAL_KEY] = now;
    try {
      const probe = openMirrorDb(dbPath);
      if (probe) {
        try {
          const fp = kvCacheFingerprint(probe);
          if (fp !== null && fp === g[MIRROR_FINGERPRINT_GLOBAL_KEY]) {
            g[MIRROR_MTIME_GLOBAL_KEY] = currentMtimeMs;
            return existing;
          }
        } finally {
          probe.close();
        }
      }
    } catch {
      return existing; // transient open failure — keep serving, recheck later
    }
    console.warn('[sidecar-cache] local mirror changed on disk — reloading');
  }

  const mirror = new Map<string, MirrorEntry>();
  g[MIRROR_GLOBAL_KEY] = mirror;
  if (!dbPath) return mirror;
  try {
    // mtime captured BEFORE the read: a write landing mid-read then still
    // looks like a change next time, instead of being silently absorbed.
    const mtimeBeforeRead = statMtimeMs(dbPath);
    const db = openMirrorDb(dbPath);
    if (!db) {
      console.warn('[sidecar-cache] node:sqlite unavailable in this runtime — mirror disabled');
      return mirror;
    }
    let meta: ReturnType<typeof readReconcileMeta> = null;
    try {
      const rows = db.prepare('SELECT key, value, type, synced_at FROM kv_cache').all() as MirrorRow[];
      let newestSyncedAt = 0;
      for (const row of rows) {
        mirror.set(row.key, { value: row.value, type: row.type });
        if (row.synced_at > newestSyncedAt) newestSyncedAt = row.synced_at;
      }
      meta = readReconcileMeta(db);
      if (meta?.fullAt) mirrorAge = Date.now() - meta.fullAt;
      else if (meta?.lastAt) mirrorAge = null; // runs happened, none complete — reported below
      else mirrorAge = newestSyncedAt > 0 ? Date.now() - newestSyncedAt : null;
      g[MIRROR_FINGERPRINT_GLOBAL_KEY] = kvCacheFingerprint(db) ?? undefined;
    } finally {
      db.close();
    }
    g[MIRROR_MTIME_GLOBAL_KEY] = mtimeBeforeRead ?? undefined;
    g[MIRROR_CHECKED_AT_GLOBAL_KEY] = Date.now();
    const age = mirrorAge === null
      ? (meta?.lastAt ? 'no complete full reconciliation yet' : 'age unknown')
      : `last full reconciliation ${formatAge(mirrorAge)} ago`;
    console.warn(`[sidecar-cache] loaded ${mirror.size} keys from local mirror at ${dbPath} (${age})`);
    if (meta?.lastAt && meta.lastFailedKeys > 0) {
      console.warn(
        `[sidecar-cache] last reconciliation (${formatAge(Date.now() - meta.lastAt)} ago) could not read `
          + `${meta.lastFailedKeys} key(s); those rows keep their previous value until a later run succeeds.`,
      );
    }
    if (mirrorAge !== null && mirrorAge > STALE_MIRROR_WARN_MS) {
      console.warn(
        `[sidecar-cache] WARNING: local mirror is ${formatAge(mirrorAge)} old — every panel is serving ` +
          'data from that point in time. Refresh it with `npm run local-sync` (or wait for the automatic ' +
          'sync in local-api-server.mjs; no restart needed either way, the mirror now reloads on change).',
      );
    }
  } catch (err) {
    console.warn('[sidecar-cache] failed to load local SQLite mirror:', err instanceof Error ? err.message : String(err));
  }
  return mirror;
}

/**
 * Test-only: force the next sidecarCacheGet() mirror miss to reload from
 * disk instead of reusing the cached Map — lets a test point
 * LOCAL_SQLITE_PATH at a fresh fixture DB per case. No production caller
 * should ever invoke this.
 */
export function __resetMirrorForTests(): void {
  delete (globalThis as GlobalWithMirror)[MIRROR_GLOBAL_KEY];
  delete (globalThis as GlobalWithMirror)[MIRROR_MTIME_GLOBAL_KEY];
  delete (globalThis as GlobalWithMirror)[MIRROR_FINGERPRINT_GLOBAL_KEY];
  delete (globalThis as GlobalWithMirror)[MIRROR_CHECKED_AT_GLOBAL_KEY];
  mirrorAge = null;
}

/**
 * Decodes a mirror row into the same shape a live Redis read would
 * produce. `string`-typed rows get the same envelope-unwrap treatment the
 * live-Upstash path applies (readCachedJson in redis.ts) so callers see
 * identical shapes regardless of data source. Non-string types
 * (zset/list/hash/set) were JSON-encoded by local-sync.mjs — parse back to
 * their native structure (e.g. a zset's flat [member, score, ...] array,
 * exactly what a live `ZRANGE ... WITHSCORES` pipeline result looks like).
 */
function decodeMirrorEntry(entry: MirrorEntry): unknown {
  if (entry.type === 'string') {
    try {
      return unwrapEnvelope(JSON.parse(entry.value)).data;
    } catch {
      return entry.value;
    }
  }
  try {
    return JSON.parse(entry.value);
  } catch {
    return null;
  }
}

export function sidecarCacheGet(key: string): unknown | null {
  const entry = store.get(key);
  if (entry) {
    if (entry.expiresAt <= Date.now()) {
      totalBytes -= entry.size;
      store.delete(key);
    } else {
      // Move to end for LRU (re-insert)
      store.delete(key);
      store.set(key, entry);
      hitCount++;
      // Envelope-unwrap to stay symmetric with the mirror branch below
      // (decodeMirrorEntry) and with redis.ts's live-Upstash path, both of
      // which always unwrap. unwrapEnvelope() is a no-op on a non-enveloped
      // value, so a handler output stored verbatim by sidecarCacheSet() is
      // returned unchanged; a raw {_seed,data} that ever gets stored is now
      // returned bare instead of flipping shape depending on LRU occupancy.
      return unwrapEnvelope(JSON.parse(entry.value)).data;
    }
  }

  // Checked BEFORE the read-only cloud mirror: this row (if present and
  // unexpired) is this process's own prior computation, carrying the exact
  // TTL its cachedFetchJson() caller asked for — a real freshness signal
  // the mirror branch below has none of (see this file's header comment).
  const persisted = readPersistedLocalCacheEntry(key);
  if (persisted) {
    hitCount++;
    // Rehydrate the in-memory store with whatever TTL is actually left, not
    // a fresh full TTL — a restart mid-window must not silently extend how
    // long a value is served past what the original caller asked for.
    const size = persisted.value.length * 2;
    if (store.size >= MAX_ENTRIES || totalBytes + size > MAX_BYTES) evictLRU(size);
    store.set(key, { value: persisted.value, expiresAt: persisted.expiresAt, size });
    totalBytes += size;
    startSweepIfNeeded();
    return unwrapEnvelope(JSON.parse(persisted.value)).data;
  }

  const mirrorEntry = loadMirror().get(key);
  if (mirrorEntry) {
    hitCount++;
    return decodeMirrorEntry(mirrorEntry);
  }

  missCount++;
  return null;
}

/**
 * Mirror-only read returning the raw decoded value plus its Redis type —
 * used by runRedisPipeline's ZRANGE/LRANGE mirror path, which needs to
 * know the type to validate the caller actually asked for a zset/list
 * before serving mirror data for it (an all-or-nothing pipeline shape
 * check, not a best-effort guess).
 */
export function sidecarMirrorGetTyped(key: string): { value: unknown; type: string } | null {
  const mirrorEntry = loadMirror().get(key);
  if (!mirrorEntry) return null;
  return { value: decodeMirrorEntry(mirrorEntry), type: mirrorEntry.type };
}

export function sidecarCacheSet(key: string, value: unknown, ttlSeconds: number): void {
  const clamped = Math.max(MIN_TTL_S, Math.min(MAX_TTL_S, ttlSeconds));
  const json = JSON.stringify(value);
  // Rough byte estimate: JS strings are UTF-16 (2 bytes per code unit).
  // Overestimates for ASCII-heavy JSON; effective limits are ~half the stated max.
  const size = json.length * 2;

  if (size > MAX_SINGLE_VALUE_BYTES) {
    console.warn(`[sidecar-cache] rejecting key "${key}": ${(size / 1024 / 1024).toFixed(1)} MB exceeds 2 MB limit`);
    return;
  }

  // Remove old entry if exists
  const existing = store.get(key);
  if (existing) {
    totalBytes -= existing.size;
    store.delete(key);
  }

  // Evict if needed
  if (store.size >= MAX_ENTRIES || totalBytes + size > MAX_BYTES) {
    evictLRU(size);
  }

  const expiresAt = Date.now() + clamped * 1000;
  store.set(key, { value: json, expiresAt, size });
  totalBytes += size;

  startSweepIfNeeded();
  persistLocalCacheEntry(key, json, expiresAt);
}

export function sidecarCacheStats(): { entries: number; bytes: number; hits: number; misses: number; mirrorEntries: number } {
  const mirror = (globalThis as GlobalWithMirror)[MIRROR_GLOBAL_KEY];
  return { entries: store.size, bytes: totalBytes, hits: hitCount, misses: missCount, mirrorEntries: mirror?.size ?? 0 };
}
