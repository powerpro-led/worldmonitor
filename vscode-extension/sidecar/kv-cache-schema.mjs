/**
 * Single definition of the operator local-mirror table schema.
 *
 * Both writers into `local-cache.db` — local-sync.mjs's full rebuild and
 * sync-listener.mjs's real-time single-row upsert — must create an identical
 * table, so the DDL lives here once instead of being hand-copied into both
 * (session 39's 7-pass review, deferred finding #7: a future column addition
 * otherwise needs remembering to edit both, silently).
 *
 * The file is always freshly (re)created by local-sync.mjs's atomic rebuild,
 * so a schema change here never needs a migration — but sync-listener.mjs may
 * touch an existing file between rebuilds, hence `IF NOT EXISTS`.
 */
export const KV_CACHE_DDL = `
  CREATE TABLE IF NOT EXISTS kv_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    type TEXT NOT NULL,
    synced_at INTEGER NOT NULL
  )
`;
