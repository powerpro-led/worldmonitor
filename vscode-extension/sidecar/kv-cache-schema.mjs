/**
 * Single definition of the operator local-mirror table schema.
 *
 * Both writers into `local-cache.db` — local-sync.mjs's full rebuild and
 * sync-listener.mjs's real-time single-row upsert — must create an identical
 * table, so the DDL lives here once instead of being hand-copied into both
 * (session 39's 7-pass review, deferred finding #7: a future column addition
 * otherwise needs remembering to edit both, silently).
 *
 * Both writers open the LIVE file directly (local-sync.mjs no longer builds
 * a separate scratch file and swaps it in — see that file's own header
 * comment for why), so `IF NOT EXISTS` matters for both of them now, not
 * just sync-listener.mjs: this DDL runs against a file that may already be
 * fully populated. A schema change here still never needs a real migration,
 * since every column so far has been additive.
 */
export const KV_CACHE_DDL = `
  CREATE TABLE IF NOT EXISTS kv_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    type TEXT NOT NULL,
    synced_at INTEGER NOT NULL
  )
`;

/**
 * The one upsert both writers use. `synced_at` means "the value as of this
 * time" — the moment its read STARTED, not when the row happened to be
 * written — and a row is only overwritten by a value that isn't older.
 *
 * Shared (not just local-sync.mjs's) since 2026-09-26: sync-listener.mjs's
 * upsertRow() had no guard and stamped Date.now() at write time, so a slow
 * catch-up read that was abandoned by a reconnect but kept running in the
 * background could land AFTER a newer live-pushed value and overwrite it —
 * and mark the stale value freshest, defeating local-sync.mjs's own guard too
 * (wmtest v2.13.16 data-pipeline review, finding G).
 */
export const UPSERT_SQL = 'INSERT INTO kv_cache (key, value, type, synced_at) VALUES (?, ?, ?, ?) '
  + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, type = excluded.type, synced_at = excluded.synced_at '
  + 'WHERE excluded.synced_at >= kv_cache.synced_at';

/**
 * Small name → value bookkeeping table beside kv_cache, written only by
 * local-sync.mjs and read by server/_shared/sidecar-cache.ts's loadMirror().
 *
 * `full_reconcile_at` — syncedAt (run START, epoch ms) of the most recent
 * full reconciliation in which every admitted key was read successfully.
 * loadMirror() reports mirror age from this, not from the newest row's
 * synced_at: a single live-pushed row used to make a days-old mirror log
 * "synced 0m ago" and suppress the 24h staleness warning (wmtest v2.13.16
 * review, finding F).
 *
 * `last_reconcile_at` / `last_reconcile_failed_keys` — the most recent run
 * whether or not it was complete, so a run that keeps skipping a few
 * unreadable chunks on a slow link is visible rather than silent.
 */
export const SYNC_META_DDL = `
  CREATE TABLE IF NOT EXISTS sync_meta (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;
