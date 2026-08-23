/**
 * In-memory TTL + LRU cache for the Tauri sidecar, backed on a miss by a
 * read-only mirror of the local SQLite sync cache
 * (vscode-extension/sidecar/local-cache.db's `kv_cache` table, populated by
 * `npm run local-sync` pulling directly from Upstash — see that script's
 * header comment for the full pipeline). Activated only when
 * LOCAL_API_MODE === 'tauri-sidecar'. No top-level side effects; the
 * in-memory sweep timer starts lazily on first write, and the mirror is
 * loaded lazily on first read miss, not at module load.
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
type GlobalWithMirror = typeof globalThis & {
  [MIRROR_GLOBAL_KEY]?: Map<string, MirrorEntry>;
  [MIRROR_MTIME_GLOBAL_KEY]?: number;
};

/**
 * Age of the newest row in the mirror, measured when it was loaded. Null
 * until the mirror is loaded, or if the table was empty.
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
    console.warn('[sidecar-cache] local mirror file changed on disk — reloading');
  }

  const mirror = new Map<string, MirrorEntry>();
  g[MIRROR_GLOBAL_KEY] = mirror;
  if (!dbPath) return mirror;
  try {
    const sqlite = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite') as
      | { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => { prepare(sql: string): { all(): unknown[] }; close(): void } }
      | undefined;
    if (!sqlite) {
      console.warn('[sidecar-cache] node:sqlite unavailable in this runtime — mirror disabled');
      return mirror;
    }
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT key, value, type, synced_at FROM kv_cache').all() as MirrorRow[];
      let newestSyncedAt = 0;
      for (const row of rows) {
        mirror.set(row.key, { value: row.value, type: row.type });
        if (row.synced_at > newestSyncedAt) newestSyncedAt = row.synced_at;
      }
      mirrorAge = newestSyncedAt > 0 ? Date.now() - newestSyncedAt : null;
    } finally {
      db.close();
    }
    g[MIRROR_MTIME_GLOBAL_KEY] = statMtimeMs(dbPath) ?? undefined;
    const age = mirrorAge === null ? 'age unknown' : `synced ${formatAge(mirrorAge)} ago`;
    console.warn(`[sidecar-cache] loaded ${mirror.size} keys from local mirror at ${dbPath} (${age})`);
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
      return JSON.parse(entry.value);
    }
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

  store.set(key, {
    value: json,
    expiresAt: Date.now() + clamped * 1000,
    size,
  });
  totalBytes += size;

  startSweepIfNeeded();
}

export function sidecarCacheStats(): { entries: number; bytes: number; hits: number; misses: number; mirrorEntries: number } {
  const mirror = (globalThis as GlobalWithMirror)[MIRROR_GLOBAL_KEY];
  return { entries: store.size, bytes: totalBytes, hits: hitCount, misses: missCount, mirrorEntries: mirror?.size ?? 0 };
}
